import { sha256Hex } from '../../src/artifacts';
import { DataSubjectService, type DataSubjectServiceDeps } from '../../src/data-subject.service';
import { DataSubjectError, DataSubjectErrorCode } from '../../src/errors';
import { Registry } from '../../src/registry';
import type { ArtifactStorage } from '../../src/storage/artifact-storage.interface';
import type {
  DurableExecutionStore,
  ExecutionRecord,
  ExecutionTransaction,
} from '../../src/storage/durable-execution-store.interface';
import type { RequestStorage } from '../../src/storage/request-storage.interface';
import type { DataSubjectRequest, EntityExecutor, ErasureEvidenceArtifact } from '../../src/types';

type BusinessRow = { id: string; tenantId: string; subjectId: string; email: string | null };
type State = {
  requests: Map<string, DataSubjectRequest>;
  executions: Map<string, ExecutionRecord>;
  rows: BusinessRow[];
};

/** Sequential fault-injection fixture only; PostgreSQL tests verify real locks and isolation. */
function transactionalFixture() {
  let committed: State = {
    requests: new Map(), executions: new Map(),
    rows: [{ id: 'private-row-id', tenantId: 'tenant-a', subjectId: 'subject-a', email: 'private@example.test' }],
  };
  let bound: State | undefined;
  let commitFault: 'before' | 'after' | undefined;
  function requests(read: () => State): RequestStorage {
    return {
      async insert(request) {
        if (read().requests.has(request.id)) throw new DataSubjectError(DataSubjectErrorCode.RequestConflict);
        read().requests.set(request.id, structuredClone(request));
      },
      async update(id, tenantId, patch) {
        const request = read().requests.get(id);
        if (!request || request.tenantId !== tenantId) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
        Object.assign(request, structuredClone(patch));
      },
      async findById(id, tenantId) {
        const request = read().requests.get(id);
        return request?.tenantId === tenantId ? structuredClone(request) : null;
      },
      async listByTenant(tenantId, options = {}) {
        return [...read().requests.values()].filter(request => request.tenantId === tenantId &&
          (!options.state || request.state === options.state)).map(request => structuredClone(request));
      },
      async listOverdue(now) {
        return [...read().requests.values()].filter(request =>
          ['created', 'validating', 'processing'].includes(request.state) && request.dueAt < now)
          .map(request => structuredClone(request));
      },
    };
  }
  const store: DurableExecutionStore = {
    requests: requests(() => committed),
    async listExpiredArtifacts(now, limit) {
      return [...committed.executions.values()].filter(record =>
        record.artifact?.bodyBase64 !== null && record.artifact?.expiresAt !== undefined &&
        Date.parse(record.artifact.expiresAt) <= now.getTime()).slice(0, limit)
        .map(({ requestId, tenantId }) => ({ requestId, tenantId }));
    },
    async reserve(candidate, idempotencyKey, payloadHash) {
      const existing = [...committed.executions.values()].find(record =>
        record.tenantId === candidate.tenantId && record.type === candidate.type &&
        record.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new DataSubjectError(DataSubjectErrorCode.RequestConflict);
        return { request: structuredClone(committed.requests.get(existing.requestId)!), created: false };
      }
      const draft = structuredClone(committed);
      await requests(() => draft).insert(candidate);
      draft.executions.set(candidate.id, {
        requestId: candidate.id, tenantId: candidate.tenantId, type: candidate.type,
        idempotencyKey, payloadHash, phase: 'pending', artifact: null, stats: null, notifications: [],
      });
      committed = draft;
      return { request: structuredClone(candidate), created: true };
    },
    async withLock<T>(id: string, tenantId: string, work: (transaction: ExecutionTransaction) => Promise<T>) {
      const draft = structuredClone(committed);
      const record = draft.executions.get(id);
      if (!record || record.tenantId !== tenantId) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
      const transaction: ExecutionTransaction = {
        record,
        requests: requests(() => draft),
        async save(next) {
          draft.executions.set(id, structuredClone(next));
          transaction.record = structuredClone(next);
        },
      };
      bound = draft;
      try {
        const result = await work(transaction);
        const fault = commitFault;
        commitFault = undefined;
        if (fault === 'before') throw new Error('connection lost before commit');
        committed = draft;
        if (fault === 'after') throw new Error('commit succeeded but response was lost');
        return result;
      } finally {
        bound = undefined;
      }
    },
  };
  return {
    store,
    committed: () => committed,
    business: () => bound ?? committed,
    failNextCommit: (when: 'before' | 'after') => { commitFault = when; },
  };
}

function setup(options: {
  noOp?: boolean;
  fieldDelete?: boolean;
  publishOutbox?: DataSubjectServiceDeps['publishOutbox'];
} = {}) {
  const database = transactionalFixture();
  let now = new Date('2026-10-11T00:00:00Z');
  let requestNumber = 0;
  let failUploads = false;
  let afterUpload: (() => void) | undefined;
  const writes: Buffer[] = [];
  const stored = new Map<string, { body: Buffer; contentType: string }>();
  const artifactStorage: ArtifactStorage = {
    async put(key, body, contentType) {
      writes.push(Buffer.from(body));
      if (failUploads) throw new Error('provider failure containing private@example.test');
      stored.set(key, { body: Buffer.from(body), contentType });
      afterUpload?.();
      return `private://${key}`;
    },
    async get(key) { return stored.get(key) ?? null; },
  };
  const select = jest.fn(async (subjectId: string, tenantId: string) =>
    database.business().rows.filter(row => row.subjectId === subjectId && row.tenantId === tenantId)
      .map(row => ({ ...row })));
  const selectByIds = jest.fn(async (ids: unknown[], tenantId: string) =>
    database.business().rows.filter(row => ids.includes(row.id) && row.tenantId === tenantId)
      .map(row => ({ ...row })));
  const erase = jest.fn<ReturnType<EntityExecutor['erase']>, Parameters<EntityExecutor['erase']>>(
    async (subjectId, tenantId, plan) => {
      const target = database.business();
      const rows = target.rows.filter(row => row.subjectId === subjectId && row.tenantId === tenantId);
      if (!options.noOp) {
        if (plan.rowLevel === 'delete-row') target.rows = target.rows.filter(row => !rows.includes(row));
        else for (const row of rows) row.email = null;
      }
      return rows.length;
    },
  );
  const registry = new Registry();
  registry.register({
    policy: {
      entityName: 'Profile', subjectField: 'subjectId', stableIdField: 'id',
      rowLevel: options.fieldDelete ? 'delete-fields' : 'delete-row',
      fields: { email: 'delete' }, exportFields: ['email'],
    },
    executor: {
      scope: { mode: 'multi-tenant', tenantField: 'tenantId' }, identityField: 'id',
      select, selectByIds, erase, anonymize: jest.fn(async () => 0),
    },
  });
  const deps: DataSubjectServiceDeps = {
    registry, requestStorage: database.store.requests, durableStore: database.store, artifactStorage,
    slaDays: 30, previewSigningKey: 'test-only-preview-signing-key-at-least-32-bytes',
    artifactRetryTtlMs: { export: 1000, erase: 1000 },
    idFactory: () => `request-${++requestNumber}`, clock: () => new Date(now),
    publishOutbox: options.publishOutbox,
  };
  return {
    ...database, registry, deps, select, selectByIds, erase, writes,
    service: () => new DataSubjectService(deps),
    failUploads: (fail: boolean) => { failUploads = fail; },
    afterUpload: (callback: () => void) => { afterUpload = callback; },
    advance: (ms: number) => { now = new Date(now.getTime() + ms); },
    record: (id = 'request-1') => structuredClone(database.committed().executions.get(id)!),
  };
}

describe('durable coordinator recovery contract', () => {
  it('commits the completed request and terminal outbox before external delivery observes them', async () => {
    const observed: string[] = [];
    const fixture = setup({
      async publishOutbox(event, _payload, delivery) {
        if (event !== 'data_subject.request_completed') return;
        const request = await fixture.store.requests.findById(delivery!.requestId, delivery!.tenantId);
        observed.push(request!.state);
        expect(fixture.record().notifications).toContainEqual(expect.objectContaining({
          id: delivery!.id, event, delivered: false,
        }));
      },
    });
    const request = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    expect(request.state).toBe('completed');
    expect(observed).toEqual(['completed']);
  });

  it('reconciles an ambiguous successful data commit by request key without selecting or erasing again', async () => {
    const fixture = setup();
    fixture.failNextCommit('after');
    await expect(fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestPersistenceFailed, requestId: 'request-1', dataOutcome: 'unknown' });
    expect(fixture.record().phase).toBe('data_committed');
    const originalBody = Buffer.from(fixture.record().artifact!.bodyBase64!, 'base64');
    const reads = fixture.select.mock.calls.length;
    const request = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    expect(request).toMatchObject({ id: 'request-1', state: 'completed', artifactHash: sha256Hex(originalBody) });
    expect(fixture.erase).toHaveBeenCalledTimes(1);
    expect(fixture.select).toHaveBeenCalledTimes(reads);
    expect(fixture.writes).toEqual([originalBody]);
  });

  it('does not automatically repeat data work after an ambiguous aborted commit', async () => {
    const fixture = setup();
    fixture.failNextCommit('before');
    await expect(fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestPersistenceFailed, dataOutcome: 'unknown' });
    expect(fixture.erase).toHaveBeenCalledTimes(1);
    expect(fixture.committed().rows).toHaveLength(1);
    expect(fixture.record()).toMatchObject({ phase: 'pending', artifact: null });
    expect(fixture.writes).toHaveLength(0);
  });

  it('uploads the original durable bytes after restart and never repeats business work', async () => {
    const fixture = setup();
    fixture.failUploads(true);
    const failed = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    expect(failed).toMatchObject({ state: 'failed', stats: { lifecycle: { dataOutcome: 'completed', recovery: 'retry_artifact' } } });
    const body = Buffer.from(fixture.record().artifact!.bodyBase64!, 'base64');
    const reads = fixture.select.mock.calls.length;
    fixture.committed().rows.push({ id: 'later-row', tenantId: 'tenant-a', subjectId: 'subject-a', email: 'later@example.test' });
    fixture.failUploads(false);
    fixture.advance(500);
    const recovered = await fixture.service().retryCompletion(failed.id, failed.tenantId);
    expect(recovered).toMatchObject({ state: 'completed', artifactHash: sha256Hex(body) });
    expect(fixture.writes).toEqual([body, body]);
    expect(fixture.record().artifact!.bodyBase64).toBeNull();
    expect(fixture.erase).toHaveBeenCalledTimes(1);
    expect(fixture.select).toHaveBeenCalledTimes(reads);
    expect(fixture.committed().rows[0].email).toBe('later@example.test');
  });

  it('recovers a lost completion commit response without another artifact upload or data execution', async () => {
    const fixture = setup();
    fixture.afterUpload(() => fixture.failNextCommit('after'));
    await expect(fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestPersistenceFailed, dataOutcome: 'unknown' });
    expect(fixture.record().phase).toBe('completed');
    expect(fixture.record().artifact!.bodyBase64).toBeNull();
    expect((await fixture.service().retryCompletion('request-1', 'tenant-a')).state).toBe('completed');
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });

  it('preserves failed field verification and failed evidence without source values or row IDs', async () => {
    const fixture = setup({ noOp: true, fieldDelete: true });
    const failed = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    expect(failed).toMatchObject({
      state: 'failed', failureReason: DataSubjectErrorCode.VerificationFailed,
      stats: { lifecycle: { failureStage: 'data_execution' }, verification: [{ entityName: 'Profile', status: 'failed' }] },
    });
    const evidence = JSON.parse(fixture.writes[0].toString('utf8')) as ErasureEvidenceArtifact;
    expect(evidence).toMatchObject({ state: 'failed', verificationOverall: 'failed', failureStage: 'data_execution' });
    expect(evidence.actions[0].verification!.fields).toEqual([{ field: 'email', strategy: 'delete', checked: 1, status: 'failed' }]);
    expect(JSON.stringify({ failed, evidence })).not.toContain('private@example.test');
    expect(JSON.stringify(evidence)).not.toContain('private-row-id');
    expect(fixture.committed().rows[0].email).toBe('private@example.test');
    expect((await fixture.service().retryCompletion(failed.id, failed.tenantId)).state).toBe('failed');
    expect(fixture.erase).toHaveBeenCalledTimes(1);
    expect(fixture.writes).toHaveLength(1);
  });

  it('discards expired export bytes atomically and never uploads them on a later retry', async () => {
    const fixture = setup();
    fixture.failUploads(true);
    const failed = await fixture.service().export('subject-a', 'tenant-a', { requestKey: 'export-a' });
    expect(fixture.record().artifact!.bodyBase64).not.toBeNull();
    fixture.advance(1000);
    fixture.failUploads(false);
    const expired = await fixture.service().retryCompletion(failed.id, failed.tenantId);
    expect(expired).toMatchObject({
      state: 'failed', failureReason: DataSubjectErrorCode.ArtifactExpired,
      stats: { lifecycle: { dataOutcome: 'completed', recovery: 'artifact_expired' } },
    });
    expect(fixture.record().artifact).toMatchObject({ bodyBase64: null, discardedAt: '2026-10-11T00:00:01.000Z' });
    await fixture.service().retryCompletion(failed.id, failed.tenantId);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.select).toHaveBeenCalledTimes(1);
    expect(fixture.erase).not.toHaveBeenCalled();
  });

  it('purges expired retry payloads through the bounded worker without a caller retrying the request', async () => {
    const fixture = setup();
    fixture.failUploads(true);
    await fixture.service().export('subject-a', 'tenant-a', { requestKey: 'export-a' });
    await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    fixture.advance(1000);
    expect(await fixture.service().expirePendingArtifacts(1)).toEqual({ expired: 1, failures: [] });
    expect(fixture.record('request-1').artifact!.bodyBase64).toBeNull();
    expect(fixture.record('request-2').artifact!.bodyBase64).not.toBeNull();
    expect(await fixture.service().expirePendingArtifacts(1)).toEqual({ expired: 1, failures: [] });
    expect(await fixture.service().expirePendingArtifacts(1)).toEqual({ expired: 0, failures: [] });
    expect(fixture.record('request-2').artifact!.bodyBase64).toBeNull();
    expect(fixture.writes).toHaveLength(2);
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });

  it('rejects changed persistent artifact bytes without uploading or rerunning the erasure', async () => {
    const fixture = setup();
    fixture.failUploads(true);
    const failed = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    fixture.committed().executions.get(failed.id)!.artifact!.bodyBase64 = Buffer.from('tampered bytes').toString('base64');
    fixture.failUploads(false);
    await expect(fixture.service().retryCompletion(failed.id, failed.tenantId))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.EvidenceReportInvalid });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });

  it('retries notification delivery with the same stable ID while preserving completed data', async () => {
    let unavailable = true;
    const ids: string[] = [];
    const fixture = setup({
      async publishOutbox(event, _payload, delivery) {
        if (event !== 'data_subject.request_completed') return;
        ids.push(delivery!.id);
        if (unavailable) throw new Error('callback secret must not be stored');
      },
    });
    const first = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a' });
    expect(first).toMatchObject({ state: 'completed', stats: { lifecycle: { notificationFailures: [{ event: 'data_subject.request_completed', code: 'dsr_operation_failed' }] } } });
    unavailable = false;
    const second = await fixture.service().retryCompletion(first.id, first.tenantId);
    expect(second.state).toBe('completed');
    expect(second.stats!.lifecycle!.notificationFailures).toBeUndefined();
    expect(ids).toEqual(['request-1:outbox:data_subject.request_completed', 'request-1:outbox:data_subject.request_completed']);
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key with a new preview while allowing completion recovery and tenant isolation', async () => {
    const fixture = setup();
    const service = fixture.service();
    const preview = await service.previewErase('subject-a', 'tenant-a');
    const first = await service.erase('subject-a', 'tenant-a', { requestKey: 'erase-a', preview });
    fixture.advance(10);
    const changed = await fixture.service().previewErase('subject-a', 'tenant-a');
    await expect(fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a', preview: changed }))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestConflict });
    expect((await fixture.service().retryCompletion(first.id, first.tenantId)).state).toBe('completed');
    await expect(fixture.service().retryCompletion(first.id, 'tenant-b'))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });

  it('reuses a committed request with its original now-expired preview without executing again', async () => {
    const fixture = setup();
    const preview = await fixture.service().previewErase('subject-a', 'tenant-a', { ttlMs: 50 });
    const first = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a', preview });
    fixture.advance(100);
    const second = await fixture.service().erase('subject-a', 'tenant-a', { requestKey: 'erase-a', preview });
    expect(second).toMatchObject({ id: first.id, state: 'completed', artifactHash: first.artifactHash });
    expect(fixture.writes).toHaveLength(1);
    expect(fixture.erase).toHaveBeenCalledTimes(1);
  });
});
