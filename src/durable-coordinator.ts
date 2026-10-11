import { sha256Hex, erasureEvidenceArtifactKey, exportArtifactKey } from './artifacts';
import { EraseRunner, ErasureVerificationError } from './erase-runner';
import { buildErasureEvidenceArtifact } from './erasure-evidence';
import { DataSubjectError, DataSubjectErrorCode, DataSubjectPersistenceError } from './errors';
import { ExportRunner } from './export-runner';
import type { DataSubjectServiceDeps, RequestContext } from './data-subject.service';
import { hashRegistryPolicy, type ErasurePlanSummary } from './erasure-plan';
import type { ErasurePreview } from './preview';
import { stableStringify } from './stable-json';
import type {
  DurableExecutionStore,
  ExecutionRecord,
  ExecutionNotification,
  ExecutionTransaction,
} from './storage/durable-execution-store.interface';
import type { DataSubjectRequest, RequestStats } from './types';

export interface DeliveryContext {
  id: string;
  requestId: string;
  tenantId: string;
}

/** Database execution and external delivery are independently resumable phases. */
export class DurableCoordinator {
  constructor(
    private readonly deps: DataSubjectServiceDeps,
    private readonly store: DurableExecutionStore,
    private readonly clock: () => Date,
    private readonly verifyPreview: (
      preview: ErasurePreview,
      subjectId: string,
      tenantId: string,
    ) => ErasurePlanSummary,
  ) {}

  async execute(
    candidate: DataSubjectRequest,
    context: RequestContext,
    payloadHash: string,
    policyHash: string,
  ): Promise<DataSubjectRequest> {
    let request: DataSubjectRequest;
    try {
      ({ request } = await this.store.reserve(candidate, context.requestKey!, payloadHash));
    } catch (error) {
      if (error instanceof DataSubjectError) throw error;
      throw new DataSubjectPersistenceError(candidate.id, candidate.tenantId, 'not_started');
    }
    let workError: unknown;
    try {
      await this.store.withLock(request.id, request.tenantId, async (tx) => {
        workError = undefined;
        const current = await this.load(tx, request);
        // A duplicate key reuses even a failed execution; retries never delete again.
        if (tx.record.phase !== 'pending' || current.state === 'failed') return;
        try {
          if (hashRegistryPolicy(this.deps.registry) !== policyHash)
            throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch);
          const expectedPlan = context.preview
            ? this.verifyPreview(context.preview, current.subjectId, current.tenantId)
            : undefined;
          await tx.requests.update(current.id, current.tenantId, {
            state: 'processing',
            stats: { entities: [], lifecycle: { dataOutcome: 'unknown' } },
          });
          this.initialNotifications(tx.record, current);
          let body: Buffer;
          let stats: RequestStats;
          let key: string;
          let contentType: string;
          if (current.type === 'erase') {
            const result = await new EraseRunner(this.deps.registry).run(
              current.subjectId,
              current.tenantId,
              {
                expectedPlan,
                afterPreScan: async () => {
                  this.enqueue(tx.record, 'outbox', 'data_subject.erasure_requested', {
                    requestId: current.id,
                    subjectId: current.subjectId,
                    tenantId: current.tenantId,
                    requestedAt: this.clock().toISOString(),
                  });
                },
              },
            );
            stats = result.stats;
            body = Buffer.from(
              stableStringify(
                buildErasureEvidenceArtifact({
                  requestId: current.id,
                  tenantId: current.tenantId,
                  generatedAt: this.clock(),
                  stats,
                  actions: result.actions,
                }),
              ),
              'utf8',
            );
            key = erasureEvidenceArtifactKey(current.tenantId, current.id);
            contentType = 'application/json';
          } else {
            const result = await new ExportRunner(
              this.deps.registry,
              this.deps.artifactStorage,
            ).prepare(current.id, current.subjectId, current.tenantId);
            body = result.body;
            stats = result.stats;
            key = exportArtifactKey(current.tenantId, current.id);
            contentType = 'application/zip';
          }
          stats.lifecycle = { dataOutcome: 'completed' };
          tx.record.stats = stats;
          tx.record.artifact = {
            key,
            contentType,
            hash: sha256Hex(body),
            bodyBase64: body.toString('base64'),
            expiresAt: this.artifactExpiry(current),
          };
          tx.record.phase = 'data_committed';
          await tx.requests.update(current.id, current.tenantId, {
            stats,
            artifactHash: tx.record.artifact.hash,
          });
          await tx.save(tx.record);
        } catch (error) {
          // A thrown callback aborts this transaction. Unknown COMMIT errors occur
          // outside the callback and must not be mistaken for a known rollback.
          workError = error;
          throw error;
        }
      });
    } catch (error) {
      if (workError === undefined || workError !== error) {
        throw new DataSubjectPersistenceError(request.id, request.tenantId, 'unknown');
      }
      try {
        await this.store.withLock(request.id, request.tenantId, async (tx) => {
          const current = await this.load(tx, request);
          if (tx.record.phase !== 'pending' || current.state === 'failed') return;
          const stats: RequestStats = {
            ...(error instanceof ErasureVerificationError ? error.stats : { entities: [] }),
            lifecycle: {
              dataOutcome: 'unknown',
              failureStage: 'data_execution',
              recovery: 'inspect_data',
            },
          };
          tx.record.stats = stats;
          if (error instanceof ErasureVerificationError) {
            const body = Buffer.from(
              stableStringify(
                buildErasureEvidenceArtifact({
                  requestId: current.id,
                  tenantId: current.tenantId,
                  generatedAt: this.clock(),
                  stats,
                  actions: error.actions,
                  state: 'failed',
                  failureStage: 'data_execution',
                }),
              ),
              'utf8',
            );
            tx.record.artifact = {
              key: erasureEvidenceArtifactKey(current.tenantId, current.id),
              contentType: 'application/json',
              hash: sha256Hex(body),
              bodyBase64: body.toString('base64'),
              expiresAt: this.artifactExpiry(current),
            };
          }
          this.initialNotifications(tx.record, current);
          this.enqueueFailure(tx.record, current, code(error));
          await tx.requests.update(current.id, current.tenantId, {
            state: 'failed',
            failedAt: this.clock(),
            completedAt: null,
            failureReason: code(error),
            stats,
          });
          await tx.save(tx.record);
        });
      } catch {
        throw new DataSubjectPersistenceError(request.id, request.tenantId, 'unknown');
      }
    }
    return this.retryCompletion(request.id, request.tenantId);
  }

  async retryCompletion(requestId: string, tenantId: string): Promise<DataSubjectRequest> {
    try {
      await this.store.withLock(requestId, tenantId, async (tx) => {
        const current = await tx.requests.findById(requestId, tenantId);
        if (!current) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
        const record = tx.record;
        // Repeated completed requests need no additional state writes.
        if (record.phase === 'completed' || record.artifact?.discardedAt) return;
        if (record.phase === 'pending' && current.state !== 'failed') {
          throw new DataSubjectError(
            DataSubjectErrorCode.InvalidStateTransition,
            'execution has not committed',
          );
        }
        const stats = record.stats ?? {
          entities: [],
          lifecycle: { dataOutcome: 'unknown' as const },
        };
        stats.lifecycle ??= { dataOutcome: record.phase === 'pending' ? 'unknown' : 'completed' };
        const retryArtifact = record.artifact;
        if (retryArtifact && retryArtifact.bodyBase64 !== null && !retryArtifact.discardedAt) {
          retryArtifact.expiresAt ??= this.artifactExpiry(current);
          if (this.clock().getTime() >= Date.parse(retryArtifact.expiresAt)) {
            retryArtifact.bodyBase64 = null;
            retryArtifact.discardedAt = this.clock().toISOString();
            stats.lifecycle.artifactFailure = {
              code: DataSubjectErrorCode.ArtifactExpired,
              recovery: 'artifact_expired',
            };
            stats.lifecycle.recovery = 'artifact_expired';
            if (record.phase === 'data_committed') stats.lifecycle.failureStage = 'artifact_write';
            await tx.requests.update(requestId, tenantId, {
              state: 'failed',
              completedAt: null,
              failedAt: this.clock(),
              failureReason:
                record.phase === 'data_committed'
                  ? DataSubjectErrorCode.ArtifactExpired
                  : current.failureReason,
            });
            this.enqueue(record, 'outbox', 'data_subject.artifact_expired', {
              requestId,
              tenantId,
              requestType: current.type,
            });
            this.enqueue(record, 'audit', 'data_subject.artifact_expired', {
              requestId,
              tenantId,
              type: current.type,
            });
          }
        }
        if (
          record.phase === 'pending' &&
          current.state === 'failed' &&
          record.artifact?.bodyBase64 !== null &&
          record.artifact
        ) {
          const artifact = record.artifact;
          const body = Buffer.from(artifact.bodyBase64!, 'base64');
          if (sha256Hex(body) !== artifact.hash)
            throw new DataSubjectError(DataSubjectErrorCode.EvidenceReportInvalid);
          try {
            const url = await this.deps.artifactStorage.put(
              artifact.key,
              body,
              artifact.contentType,
            );
            artifact.url = url;
            artifact.bodyBase64 = null;
            delete stats.lifecycle.artifactFailure;
            stats.evidence = {
              schemaVersion: 'data-subject.evidence.v2',
              artifactHash: artifact.hash,
              artifactUrl: url,
            };
          } catch {
            stats.lifecycle.artifactFailure = {
              code: DataSubjectErrorCode.ArtifactWriteFailed,
              recovery: 'retry_artifact',
            };
          }
          if (artifact.url !== undefined) {
            await tx.requests.update(requestId, tenantId, {
              artifactHash: artifact.hash,
              artifactUrl: artifact.url,
            });
          }
        }
        if (record.phase === 'data_committed' && !record.artifact?.discardedAt) {
          const artifact = record.artifact;
          if (!artifact || artifact.bodyBase64 === null)
            throw new DataSubjectError(DataSubjectErrorCode.EvidenceReportInvalid);
          const body = Buffer.from(artifact.bodyBase64, 'base64');
          if (sha256Hex(body) !== artifact.hash)
            throw new DataSubjectError(DataSubjectErrorCode.EvidenceReportInvalid);
          let url: string | undefined;
          try {
            url = await this.deps.artifactStorage.put(artifact.key, body, artifact.contentType);
          } catch {
            stats.lifecycle.failureStage = 'artifact_write';
            stats.lifecycle.recovery = 'retry_artifact';
            await tx.requests.update(requestId, tenantId, {
              state: 'failed',
              completedAt: null,
              failedAt: this.clock(),
              failureReason: DataSubjectErrorCode.ArtifactWriteFailed,
              stats,
            });
            record.stats = stats;
            this.enqueueFailure(record, current, DataSubjectErrorCode.ArtifactWriteFailed);
          }
          if (url !== undefined) {
            artifact.url = url;
            artifact.bodyBase64 = null;
            record.phase = 'completed';
            delete stats.lifecycle.failureStage;
            delete stats.lifecycle.recovery;
            if (current.type === 'erase') {
              stats.evidence = {
                schemaVersion: 'data-subject.evidence.v2',
                artifactHash: artifact.hash,
                artifactUrl: url,
              };
            }
            await tx.requests.update(requestId, tenantId, {
              state: 'completed',
              completedAt: this.clock(),
              failedAt: null,
              failureReason: null,
              artifactHash: artifact.hash,
              artifactUrl: url,
              stats,
            });
            this.enqueue(record, 'outbox', 'data_subject.request_completed', {
              requestId,
              tenantId,
              requestType: current.type,
              state: 'completed',
              artifactHash: artifact.hash,
            });
            this.enqueue(record, 'audit', 'data_subject.request_completed', {
              requestId,
              tenantId,
              type: current.type,
              artifactHash: artifact.hash,
            });
          }
        }
        record.stats = stats;
        await tx.requests.update(requestId, tenantId, { stats });
        await tx.save(record);
      });
      return await this.deliverNotifications(requestId, tenantId);
    } catch (error) {
      if (error instanceof DataSubjectError) throw error;
      throw new DataSubjectPersistenceError(requestId, tenantId, 'unknown');
    }
  }

  private async deliverNotifications(
    requestId: string,
    tenantId: string,
  ): Promise<DataSubjectRequest> {
    return this.store.withLock(requestId, tenantId, async (tx) => {
      const record = tx.record;
      if (record.notifications.every((notification) => notification.delivered)) {
        const current = await tx.requests.findById(requestId, tenantId);
        if (!current) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
        return current;
      }
      const stats = record.stats ?? {
        entities: [],
        lifecycle: { dataOutcome: 'unknown' as const },
      };
      stats.lifecycle ??= { dataOutcome: 'unknown' };
      // The durable list is an outbox in the same transaction as data changes.
      // External delivery is at least once; downstream deduplicates stable IDs.
      for (const notification of record.notifications) {
        if (notification.delivered) continue;
        const delivery = { id: notification.id, requestId, tenantId };
        try {
          if (notification.channel === 'outbox')
            await this.deps.publishOutbox?.(notification.event, notification.payload, delivery);
          else await this.deps.publishAudit?.(notification.event, notification.payload, delivery);
          notification.delivered = true;
          delete notification.lastError;
        } catch (error) {
          notification.lastError = code(error);
        }
      }
      const failures = record.notifications
        .filter((n) => !n.delivered)
        .map((n) => ({
          channel: n.channel,
          event: n.event,
          code: n.lastError ?? 'dsr_operation_failed',
          recovery: 'retry_notification' as const,
        }));
      if (failures.length) stats.lifecycle.notificationFailures = failures;
      else delete stats.lifecycle.notificationFailures;
      record.stats = stats;
      await tx.requests.update(requestId, tenantId, { stats });
      await tx.save(record);
      return (await tx.requests.findById(requestId, tenantId))!;
    });
  }

  private initialNotifications(record: ExecutionRecord, request: DataSubjectRequest): void {
    this.enqueue(record, 'outbox', 'data_subject.request_created', {
      requestId: request.id,
      requestType: request.type,
      tenantId: request.tenantId,
      subjectId: request.subjectId,
    });
    this.enqueue(record, 'audit', 'data_subject.request_created', {
      requestId: request.id,
      type: request.type,
      tenantId: request.tenantId,
    });
    this.enqueue(record, 'audit', 'data_subject.request_processing', {
      requestId: request.id,
      type: request.type,
      tenantId: request.tenantId,
    });
  }

  private enqueueFailure(
    record: ExecutionRecord,
    request: DataSubjectRequest,
    failureReason: string,
  ): void {
    const lifecycle = record.stats?.lifecycle;
    this.enqueue(record, 'outbox', 'data_subject.request_failed', {
      requestId: request.id,
      requestType: request.type,
      tenantId: request.tenantId,
      failureReason,
      failureStage: lifecycle?.failureStage,
      dataOutcome: lifecycle?.dataOutcome,
      recovery: lifecycle?.recovery,
    });
    this.enqueue(record, 'audit', 'data_subject.request_failed', {
      requestId: request.id,
      type: request.type,
      tenantId: request.tenantId,
      failureReason,
      failureStage: lifecycle?.failureStage,
      dataOutcome: lifecycle?.dataOutcome,
    });
  }

  private enqueue(
    record: ExecutionRecord,
    channel: ExecutionNotification['channel'],
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const id = `${record.requestId}:${channel}:${event}`;
    if (!record.notifications.some((n) => n.id === id))
      record.notifications.push({ id, channel, event, payload, delivered: false });
  }

  private artifactExpiry(request: DataSubjectRequest): string {
    const ttl = this.deps.artifactRetryTtlMs?.[request.type] ?? 86_400_000;
    return new Date(request.createdAt.getTime() + ttl).toISOString();
  }

  private async load(
    tx: ExecutionTransaction,
    request: DataSubjectRequest,
  ): Promise<DataSubjectRequest> {
    const current = await tx.requests.findById(request.id, request.tenantId);
    if (!current) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
    return current;
  }
}

function code(error: unknown): string {
  return error instanceof DataSubjectError ? error.code : 'dsr_operation_failed';
}
