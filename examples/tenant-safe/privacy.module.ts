import {
  BadRequestException,
  CanActivate,
  Controller,
  DynamicModule,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  HttpException,
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
  DataSubjectPersistenceError,
  DataSubjectRequest,
  DataSubjectService,
  sha256Hex,
  type ErasurePreview,
  type RequestContext,
} from '../../src';

export type PrivacyAction = 'export' | 'erase' | 'read' | 'retry' | 'export:download' | 'evidence:download';

export interface PrivacyExecutionOptions {
  durable: boolean;
  requireErasePreview: boolean;
}
const executionOptions = Symbol('example:privacy-execution-options');

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
  constructor(
    @Inject(DataSubjectService) private readonly service: DataSubjectService,
    @Inject(HostAccessService) private readonly access: HostAccessService,
    @Inject(executionOptions) private readonly options: PrivacyExecutionOptions,
  ) {}

  @Post('exports')
  @SetMetadata(actionMetadata, 'export')
  @Header('Cache-Control', 'no-store')
  async exportOwnData(@Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    return publicStatus(await callService(() => this.service.export(
      principal.subjectId, principal.tenantId, this.requestContext(request, principal),
    )));
  }

  @Post('erasure/preview')
  @SetMetadata(actionMetadata, 'erase')
  @Header('Cache-Control', 'no-store')
  async previewOwnErasure(@Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    return callService(() => this.service.previewErase(principal.subjectId, principal.tenantId));
  }

  @Post('erasure')
  @SetMetadata(actionMetadata, 'erase')
  @Header('Cache-Control', 'no-store')
  async eraseOwnData(@Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    const preview = readPreview(request.body);
    if (this.options.requireErasePreview && !preview) throw new BadRequestException('An erasure preview is required');
    return publicStatus(await callService(() => this.service.erase(principal.subjectId, principal.tenantId, {
      ...this.requestContext(request, principal), ...(preview ? { preview } : {}),
    })));
  }

  @Post('requests/:id/retry-completion')
  @SetMetadata(actionMetadata, 'retry')
  @Header('Cache-Control', 'no-store')
  async retryOwnCompletion(@Param('id') id: string, @Req() request: PrivacyHttpRequest) {
    const principal = requirePrincipal(request);
    await this.ownedRequest(id, principal);
    return publicStatus(await callService(() => this.service.retryCompletion(id, principal.tenantId)));
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
    const permission = owned.type === 'export' ? 'export:download' : 'evidence:download';
    if (!(await this.access.isAllowed(principal, permission))) throw new ForbiddenException();
    // Failed erasure evidence needs a separate host-reviewed delivery policy.
    if (!artifactRecorded(owned)) throw new NotFoundException();
    const artifact = await callService(() => this.service.getArtifact(id, principal.tenantId));
    const contentType = owned.type === 'export' ? 'application/zip' : 'application/json';
    if (!artifact || artifact.contentType !== contentType || sha256Hex(artifact.body) !== owned.artifactHash) {
      throw new NotFoundException();
    }
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
      return callService(() => Promise.reject(error));
    }
    // Tenant scoping alone does not authorize one user to read another user's request.
    if (request.subjectId !== principal.subjectId) throw new NotFoundException();
    return request;
  }

  private requestContext(request: PrivacyHttpRequest, principal: PrivacyPrincipal): RequestContext {
    const key = request.headers['idempotency-key'];
    if (key === undefined && !this.options.durable) return { requestedBy: principal.actorId };
    if (!this.options.durable) throw new BadRequestException('Idempotency-Key requires durable execution');
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key)) {
      throw new BadRequestException('A single 1–200 character Idempotency-Key is required');
    }
    return {
      requestedBy: principal.actorId,
      // Stable for retries, isolated from other actors and subjects in the same tenant.
      requestKey: sha256Hex(JSON.stringify([principal.actorId, principal.subjectId, key])),
    };
  }
}

export interface TenantSafePrivacyOptions extends DataSubjectModuleOptions {
  /** Require the signed preview returned by POST erasure/preview before erasure. */
  requireErasePreview?: boolean;
}

@Module({})
export class TenantSafePrivacyModule {
  static forRoot(options: TenantSafePrivacyOptions, access?: HostAccessService): DynamicModule {
    const { requireErasePreview = false, ...serviceOptions } = options;
    if (requireErasePreview && !options.durableStore && !options.runInTransaction) {
      throw new Error('Required erasure previews need transaction-bound executors');
    }
    return {
      module: TenantSafePrivacyModule,
      imports: [DataSubjectModule.forRoot(serviceOptions)],
      controllers: [PrivacyController],
      providers: [
        PrivacyIdentityGuard,
        { provide: HostAccessService, useValue: access ?? new DenyAllHostAccessService() },
        { provide: executionOptions, useValue: { durable: !!options.durableStore, requireErasePreview } },
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

function readPreview(body: unknown): ErasurePreview | undefined {
  if (body === undefined) return undefined;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequestException('Expected an object body');
  if (!Object.hasOwn(body, 'preview')) return undefined;
  const preview = (body as { preview: unknown }).preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) throw new BadRequestException('Invalid erasure preview');
  // The core verifies the signature, scope, expiry and current plan inside execution.
  return preview as ErasurePreview;
}

async function callService<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DataSubjectError) {
      throw new HttpException({
        code: error.code,
        ...(error instanceof DataSubjectPersistenceError ? {
          requestId: error.requestId, dataOutcome: error.dataOutcome, recovery: error.recovery,
        } : {}),
      }, error.httpStatus);
    }
    throw error;
  }
}

function artifactRecorded(request: DataSubjectRequest): boolean {
  return request.state === 'completed' && request.artifactHash !== null && !request.stats?.lifecycle?.artifactFailure;
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
    verification: request.stats?.verification,
    evidenceVersion: request.stats?.evidence?.schemaVersion,
    // Metadata only: the private object may have expired since it was written.
    artifactReady: artifactRecorded(request),
  };
}
