import {
  CanActivate,
  Controller,
  DynamicModule,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  SetMetadata,
  StreamableFile,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// In an application, replace this repository-local import with @nestarc/data-subject.
import {
  DataSubjectModule,
  DataSubjectModuleOptions,
  DataSubjectError,
  DataSubjectErrorCode,
  DataSubjectRequest,
  DataSubjectService,
} from '../../src';

export type PrivacyAction = 'export' | 'erase' | 'read';

export interface AuthenticatedActor {
  actorId: string;
  /** Resolved from a validated session and current tenant membership. */
  tenantId: string;
}

export interface VerifiedSubject {
  /** Resolved from your identity records, never from the HTTP request body. */
  subjectId: string;
  /** Your verification policy decides the proof's validity period. */
  validUntil: Date;
}

/** Implement using the host application's authentication and identity services. */
export abstract class HostAccessService {
  abstract authenticateBearer(token: string): Promise<AuthenticatedActor | null>;
  abstract isAllowed(actor: AuthenticatedActor, action: PrivacyAction): Promise<boolean>;
  abstract verifyOwnSubject(actor: AuthenticatedActor): Promise<VerifiedSubject | null>;
}

/** The example cannot accidentally accept a token before host wiring is complete. */
export class DenyAllHostAccessService extends HostAccessService {
  async authenticateBearer(): Promise<null> { return null; }
  async isAllowed(): Promise<boolean> { return false; }
  async verifyOwnSubject(): Promise<null> { return null; }
}

const actionMetadata = 'example:privacy-action';
const verifiedContext = Symbol('example:verified-privacy-context');
interface PrivacyPrincipal extends AuthenticatedActor { subjectId: string }

export interface PrivacyHttpRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  [verifiedContext]?: PrivacyPrincipal;
}

@Injectable()
export class PrivacyIdentityGuard implements CanActivate {
  constructor(
    @Inject(HostAccessService) private readonly access: HostAccessService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PrivacyHttpRequest>();
    // Drop any context supplied by upstream middleware before validating again.
    delete request[verifiedContext];
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === 'string'
      ? /^Bearer ([^\s]+)$/i.exec(authorization)
      : null;
    if (!bearer) throw new UnauthorizedException();

    const actor = await this.access.authenticateBearer(bearer[1]);
    if (!actor || !isNonblank(actor.actorId) || !isNonblank(actor.tenantId)) {
      throw new UnauthorizedException();
    }

    const action = this.reflector.get<PrivacyAction>(actionMetadata, context.getHandler());
    if (!action || !(await this.access.isAllowed(actor, action))) {
      throw new ForbiddenException();
    }

    const subject = await this.access.verifyOwnSubject(actor);
    if (!subject || !isNonblank(subject.subjectId)
      || !(subject.validUntil instanceof Date)
      || !(subject.validUntil.getTime() > Date.now())) {
      throw new ForbiddenException('Subject verification is required');
    }

    request[verifiedContext] = { ...actor, subjectId: subject.subjectId };
    return true;
  }
}

@Controller('me/privacy')
@UseGuards(PrivacyIdentityGuard)
export class PrivacyController {
  constructor(@Inject(DataSubjectService) private readonly service: DataSubjectService) {}

  @Post('exports')
  @SetMetadata(actionMetadata, 'export')
  @Header('Cache-Control', 'no-store')
  async exportOwnData(@Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    return publicStatus(await this.service.export(principal.subjectId, principal.tenantId, {
      requestedBy: principal.actorId,
    }));
  }

  @Post('erasure')
  @SetMetadata(actionMetadata, 'erase')
  @Header('Cache-Control', 'no-store')
  async eraseOwnData(@Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    return publicStatus(await this.service.erase(principal.subjectId, principal.tenantId, {
      requestedBy: principal.actorId,
    }));
  }

  @Get('requests/:id')
  @SetMetadata(actionMetadata, 'read')
  @Header('Cache-Control', 'no-store')
  async getOwnRequest(@Param('id') id: string, @Req() request: PrivacyHttpRequest) {
    return publicStatus(await this.ownedRequest(id, requirePrincipal(request)));
  }

  @Get('requests/:id/artifact')
  @SetMetadata(actionMetadata, 'read')
  @Header('Cache-Control', 'no-store')
  async downloadOwnArtifact(@Param('id') id: string, @Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    const owned = await this.ownedRequest(id, principal);
    const artifact = await this.service.getArtifact(id, principal.tenantId);
    if (!artifact) throw new NotFoundException();
    return new StreamableFile(artifact.body, {
      type: artifact.contentType,
      disposition: owned.type === 'export'
        ? 'attachment; filename="personal-data.zip"'
        : 'attachment; filename="erasure-evidence.json"',
    });
  }

  private async ownedRequest(id: string, principal: PrivacyPrincipal) {
    let request: DataSubjectRequest;
    try {
      request = await this.service.getRequest(id, principal.tenantId);
    } catch (error) {
      if (error instanceof DataSubjectError && error.code === DataSubjectErrorCode.RequestNotFound) {
        throw new NotFoundException();
      }
      throw error;
    }
    // Tenant scoping alone does not authorize one user to read another user's request.
    if (request.subjectId !== principal.subjectId) throw new NotFoundException();
    return request;
  }
}

@Module({})
export class TenantSafePrivacyModule {
  static forRoot(options: DataSubjectModuleOptions, access?: HostAccessService): DynamicModule {
    return {
      module: TenantSafePrivacyModule,
      imports: [DataSubjectModule.forRoot(options)],
      controllers: [PrivacyController],
      providers: [
        PrivacyIdentityGuard,
        { provide: HostAccessService, useValue: access ?? new DenyAllHostAccessService() },
      ],
    };
  }
}

function requirePrincipal(request: PrivacyHttpRequest): PrivacyPrincipal {
  const principal = request[verifiedContext];
  if (!principal) throw new UnauthorizedException();
  return principal;
}

function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function publicStatus(request: DataSubjectRequest) {
  return {
    id: request.id,
    type: request.type,
    state: request.state,
    createdAt: request.createdAt,
    dueAt: request.dueAt,
    completedAt: request.completedAt,
    failedAt: request.failedAt,
    failureReason: request.failureReason,
    lifecycle: request.stats?.lifecycle,
    artifactReady: request.state === 'completed' && request.artifactHash !== null,
  };
}
