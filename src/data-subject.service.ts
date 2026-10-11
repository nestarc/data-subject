import { randomUUID } from 'node:crypto';

import { erasureEvidenceArtifactKey, exportArtifactKey, sha256Hex } from './artifacts';
import { EraseRunner } from './erase-runner';
import { buildErasureEvidenceArtifact } from './erasure-evidence';
import { DataSubjectError, DataSubjectErrorCode, DataSubjectPersistenceError } from './errors';
import { ExportRunner } from './export-runner';
import type { Registry } from './registry';
import { stableStringify } from './stable-json';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStorage } from './storage/request-storage.interface';
import type {
  DataSubjectRequest,
  FailureStage,
  RequestLifecycle,
  RequestState,
  RequestStats,
  RequestType,
} from './types';

export interface RequestContext {
  /** The host must authenticate this actor and authorize the verified subject first. */
  requestedBy: string;
}

export interface DataSubjectServiceDeps {
  registry: Registry;
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays: number;
  /** Omit for multi-tenant mode. Every executor must declare a matching scope. */
  singleTenantId?: string;
  idFactory?: () => string;
  clock?: () => Date;
  publishOutbox?: (type: string, payload: unknown) => Promise<void>;
  publishAudit?: (event: string, data: Record<string, unknown>) => Promise<void>;
  /** Bind every executor to the transaction client; resolve only after commit. */
  runInTransaction?: <T>(work: () => Promise<T>) => Promise<T>;
}

export class DataSubjectService {
  private readonly idFactory: () => string;
  private readonly clock: () => Date;
  private readonly publishOutbox: NonNullable<DataSubjectServiceDeps['publishOutbox']>;
  private readonly publishAudit: NonNullable<DataSubjectServiceDeps['publishAudit']>;
  private readonly runInTransaction: NonNullable<DataSubjectServiceDeps['runInTransaction']>;

  constructor(private readonly deps: DataSubjectServiceDeps) {
    this.idFactory = deps.idFactory ?? (() => randomUUID());
    this.clock = deps.clock ?? (() => new Date());
    this.publishOutbox = deps.publishOutbox ?? (async () => {});
    this.publishAudit = deps.publishAudit ?? (async () => {});
    this.runInTransaction = deps.runInTransaction ?? (async (work) => work());
    if (deps.singleTenantId !== undefined) requireIdentifier(deps.singleTenantId);
    if (!Number.isFinite(deps.slaDays) || deps.slaDays <= 0) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'slaDays must be positive');
    }
  }

  async export(
    subjectId: string,
    tenantId: string,
    context?: RequestContext,
  ): Promise<DataSubjectRequest> {
    return this.execute('export', subjectId, tenantId, context);
  }

  async erase(
    subjectId: string,
    tenantId: string,
    context?: RequestContext,
  ): Promise<DataSubjectRequest> {
    return this.execute('erase', subjectId, tenantId, context);
  }

  async getRequest(id: string, tenantId: string): Promise<DataSubjectRequest> {
    requireIdentifier(id);
    this.assertTenant(tenantId);
    return this.mustLoad(id, tenantId);
  }

  /** Host authorization must also check the request's subject before serving its bytes. */
  async getArtifact(id: string, tenantId: string): ReturnType<ArtifactStorage['get']> {
    const request = await this.getRequest(id, tenantId);
    if (!request.artifactHash) return null;
    const key =
      request.type === 'export'
        ? exportArtifactKey(tenantId, id)
        : erasureEvidenceArtifactKey(tenantId, id);
    return this.deps.artifactStorage.get(key);
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    this.assertTenant(tenantId);
    return this.deps.requestStorage.listByTenant(tenantId, opts);
  }

  /** Privileged background administration API; do not expose as a tenant route. */
  async listOverdue(): Promise<DataSubjectRequest[]> {
    return this.deps.requestStorage.listOverdue(this.clock());
  }

  private async execute(
    type: RequestType,
    subjectId: string,
    tenantId: string,
    context?: RequestContext,
  ): Promise<DataSubjectRequest> {
    requireIdentifier(subjectId);
    this.assertTenant(tenantId);
    if (context) requireIdentifier(context.requestedBy);
    this.assertExecutors(tenantId);
    const request = await this.createRequest(type, subjectId, tenantId, context);
    const lifecycle: RequestLifecycle = { dataOutcome: 'not_started' };
    let stats: RequestStats = { entities: [], lifecycle };
    let stage: FailureStage = 'request_created';
    let artifactHash: string | null = null;
    let artifactUrl: string | null = null;
    let state: 'completed' | 'failed';
    let failureReason: string | null = null;

    try {
      await this.publishOutbox('data_subject.request_created', {
        requestId: request.id,
        requestType: type,
        subjectId,
        tenantId,
      });
      await this.publishAudit('data_subject.request_created', {
        requestId: request.id,
        type,
        tenantId,
      });
      stage = 'processing';
      await this.deps.requestStorage.update(request.id, tenantId, { state: 'processing', stats });
      await this.publishAudit('data_subject.request_processing', {
        requestId: request.id,
        type,
        tenantId,
      });
      // Persist uncertainty before any data work: a process/storage outage after
      // commit must never leave a durable claim that execution was not started.
      await this.deps.requestStorage.update(request.id, tenantId, {
        stats: { ...stats, lifecycle: { ...lifecycle, dataOutcome: 'unknown' } },
      });
      lifecycle.dataOutcome = 'unknown';
      stage = 'data_execution';
      let body: Buffer;
      let key: string;
      let contentType: string;
      if (type === 'export') {
        const prepared = await new ExportRunner(
          this.deps.registry,
          this.deps.artifactStorage,
        ).prepare(request.id, subjectId, tenantId);
        stats = { ...prepared.stats, lifecycle };
        body = prepared.body;
        key = exportArtifactKey(tenantId, request.id);
        contentType = 'application/zip';
      } else {
        const result = await this.runInTransaction(() =>
          new EraseRunner(this.deps.registry).run(subjectId, tenantId, {
            afterPreScan: () =>
              this.publishOutbox('data_subject.erasure_requested', {
                requestId: request.id,
                subjectId,
                tenantId,
                requestedAt: this.clock().toISOString(),
              }),
          }),
        );
        stats = { ...result.stats, lifecycle };
        lifecycle.dataOutcome = 'completed';
        stage = 'artifact_write';
        body = Buffer.from(
          stableStringify(
            buildErasureEvidenceArtifact({
              requestId: request.id,
              tenantId,
              generatedAt: this.clock(),
              stats: result.stats,
              actions: result.actions,
            }),
          ),
          'utf8',
        );
        key = erasureEvidenceArtifactKey(tenantId, request.id);
        contentType = 'application/json';
      }
      // The transaction has resolved: artifact/callback failures cannot roll back the data.
      lifecycle.dataOutcome = 'completed';
      stage = 'completion_persistence';
      await this.deps.requestStorage.update(request.id, tenantId, { stats });
      stage = 'artifact_write';
      artifactHash = sha256Hex(body);
      artifactUrl = await this.deps.artifactStorage.put(key, body, contentType);
      if (type === 'erase') {
        stats.evidence = { schemaVersion: 'data-subject.evidence.v1', artifactHash, artifactUrl };
      }
      stage = 'completion_persistence';
      await this.deps.requestStorage.update(request.id, tenantId, {
        state: 'completed',
        completedAt: this.clock(),
        failedAt: null,
        failureReason: null,
        stats,
        artifactHash,
        artifactUrl,
      });
      state = 'completed';
    } catch (error) {
      state = 'failed';
      failureReason =
        stage === 'artifact_write' ? DataSubjectErrorCode.ArtifactWriteFailed : failureCode(error);
      lifecycle.failureStage = stage;
      lifecycle.recovery = recoveryFor(stage, lifecycle.dataOutcome);
      try {
        await this.deps.requestStorage.update(request.id, tenantId, {
          state,
          failedAt: this.clock(),
          completedAt: null,
          failureReason,
          stats,
          artifactHash,
          artifactUrl,
        });
      } catch {
        throw new DataSubjectPersistenceError(request.id, tenantId, lifecycle.dataOutcome);
      }
    }

    // Each terminal channel is attempted independently. A callback exception must
    // never change a committed operation into a failed data operation.
    const event = `data_subject.request_${state}`;
    const payload =
      state === 'completed'
        ? { requestId: request.id, requestType: type, tenantId, state, artifactHash }
        : {
            requestId: request.id,
            requestType: type,
            tenantId,
            failureReason,
            failureStage: stage,
            dataOutcome: lifecycle.dataOutcome,
            recovery: lifecycle.recovery,
          };
    const audit =
      state === 'completed'
        ? { requestId: request.id, type, tenantId, artifactHash }
        : {
            requestId: request.id,
            type,
            tenantId,
            failureReason,
            failureStage: stage,
            dataOutcome: lifecycle.dataOutcome,
          };
    for (const channel of ['outbox', 'audit'] as const) {
      try {
        if (channel === 'outbox') await this.publishOutbox(event, payload);
        else await this.publishAudit(event, audit);
      } catch (error) {
        (lifecycle.notificationFailures ??= []).push({
          channel,
          event,
          code: failureCode(error),
          recovery: 'retry_notification',
        });
      }
    }
    if (lifecycle.notificationFailures?.length) {
      // If storage itself is unavailable this rejects, leaving the durable terminal
      // state intact. Callers must reconcile by request ID instead of retrying erase.
      try {
        await this.deps.requestStorage.update(request.id, tenantId, { stats });
      } catch {
        throw new DataSubjectPersistenceError(request.id, tenantId, lifecycle.dataOutcome);
      }
    }
    try {
      return await this.mustLoad(request.id, tenantId);
    } catch {
      throw new DataSubjectPersistenceError(request.id, tenantId, lifecycle.dataOutcome);
    }
  }

  private assertTenant(tenantId: string): void {
    requireIdentifier(tenantId);
    if (this.deps.singleTenantId !== undefined && tenantId !== this.deps.singleTenantId) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidScope, 'single tenant does not match');
    }
  }

  private assertExecutors(tenantId: string): void {
    for (const { executor, policy } of this.deps.registry.list()) {
      const scope = executor.scope;
      const valid =
        this.deps.singleTenantId === undefined
          ? scope?.mode === 'multi-tenant' &&
            typeof scope.tenantField === 'string' &&
            scope.tenantField.trim().length > 0 &&
            scope.tenantField !== policy.subjectField
          : scope?.mode === 'single-tenant' && scope.tenantId === tenantId;
      if (!valid)
        throw new DataSubjectError(
          DataSubjectErrorCode.InvalidScope,
          'executor scope must match service tenancy',
        );
    }
  }

  private async createRequest(
    type: RequestType,
    subjectId: string,
    tenantId: string,
    context?: RequestContext,
  ): Promise<DataSubjectRequest> {
    const now = this.clock();
    const request: DataSubjectRequest = {
      id: this.idFactory(),
      tenantId,
      subjectId,
      type,
      state: 'created',
      createdAt: now,
      dueAt: new Date(now.getTime() + this.deps.slaDays * 86_400_000),
      completedAt: null,
      failedAt: null,
      failureReason: null,
      artifactHash: null,
      artifactUrl: null,
      stats: null,
      requestedBy: context?.requestedBy ?? null,
    };
    requireIdentifier(request.id);
    try {
      await this.deps.requestStorage.insert(request);
    } catch (error) {
      if (error instanceof DataSubjectError && error.code === DataSubjectErrorCode.RequestConflict)
        throw error;
      throw new DataSubjectPersistenceError(request.id, tenantId, 'not_started');
    }
    return request;
  }

  private async mustLoad(id: string, tenantId: string): Promise<DataSubjectRequest> {
    const request = await this.deps.requestStorage.findById(id, tenantId);
    if (!request) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
    return request;
  }
}

function requireIdentifier(value: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidInput,
      'identifiers must be nonblank strings',
    );
  }
  try {
    encodeURIComponent(value);
  } catch {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidInput,
      'identifiers must contain valid Unicode',
    );
  }
}

function failureCode(error: unknown): string {
  // Database/provider errors can contain subjects, credentials or query parameters.
  return error instanceof DataSubjectError ? error.code : 'dsr_operation_failed';
}

function recoveryFor(
  stage: FailureStage,
  outcome: RequestLifecycle['dataOutcome'],
): RequestLifecycle['recovery'] {
  if (stage === 'artifact_write') return 'retry_artifact';
  if (stage === 'completion_persistence') return 'reconcile_request';
  return outcome === 'not_started' ? 'retry_request' : 'inspect_data';
}
