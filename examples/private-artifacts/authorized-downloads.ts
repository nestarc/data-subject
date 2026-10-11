import { erasureEvidenceArtifactKey, exportArtifactKey } from '../../src/artifacts';
import type { DataSubjectService } from '../../src/data-subject.service';
import type { PrivateS3ArtifactStorage } from './private-s3-storage';

export interface VerifiedArtifactActor {
  /** Derive all fields from authenticated server-side context, never body/query. */
  tenantId: string;
  subjectId: string;
  actorId: string;
  permissions: ReadonlyArray<'export:download' | 'evidence:download'>;
}

/** Host identity/subject verification must finish before constructing the actor. */
export class AuthorizedArtifactDownloads {
  constructor(
    private readonly service: Pick<DataSubjectService, 'getRequest'>,
    private readonly storage: PrivateS3ArtifactStorage,
  ) {}

  async download(requestId: string, actor: VerifiedArtifactActor) {
    const { key, hash } = await this.authorize(requestId, actor);
    return this.storage.get(key, hash);
  }

  async link(requestId: string, actor: VerifiedArtifactActor, expiresInSeconds = 60) {
    const { key, hash } = await this.authorize(requestId, actor);
    return this.storage.signDownload(key, expiresInSeconds, hash);
  }

  private async authorize(requestId: string, actor: VerifiedArtifactActor): Promise<{ key: string; hash: string }> {
    if (![actor.actorId, actor.tenantId, actor.subjectId, requestId].every((id) => typeof id === 'string' && id.trim())) {
      throw new Error('Artifact not available');
    }
    const request = await this.service.getRequest(requestId, actor.tenantId);
    if (request.id !== requestId || request.tenantId !== actor.tenantId || request.subjectId !== actor.subjectId ||
        request.state !== 'completed' || !request.artifactHash ||
        !actor.permissions.includes(request.type === 'export' ? 'export:download' : 'evidence:download')) {
      throw new Error('Artifact not available');
    }
    // Ignore the persisted artifactUrl. A URL/key from a client or database must
    // never override the namespace derived from this authorized request.
    const key = request.type === 'export'
      ? exportArtifactKey(actor.tenantId, request.id)
      : erasureEvidenceArtifactKey(actor.tenantId, request.id);
    return { key, hash: request.artifactHash };
  }
}
