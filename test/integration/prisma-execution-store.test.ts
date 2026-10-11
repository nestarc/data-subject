import { createHash } from 'node:crypto';
import { DataSubjectErrorCode } from '../../src/errors';
import type { DataSubjectRequest } from '../../src/types';
import {
  PrismaExecutionStore,
  type PrismaExecutionClient,
  type PrismaExecutionDelegate,
  type PrismaExecutionTransactionClient,
} from '../../src/storage/prisma-execution-store';
import type { PrismaDataSubjectRequestDelegate } from '../../src/storage/prisma-request-storage';
import type { ExecutionRecord } from '../../src/storage/durable-execution-store.interface';

const hash = createHash('sha256').update('payload').digest('hex');

function request(id = 'request-1', tenantId = 'tenant-1'): DataSubjectRequest {
  return {
    id, tenantId, subjectId: 'subject-1', type: 'erase', state: 'created',
    createdAt: new Date('2026-01-01'), dueAt: new Date('2026-02-01'),
    completedAt: null, failedAt: null, failureReason: null,
    artifactHash: null, artifactUrl: null, stats: null, requestedBy: null,
  };
}

type Row = Record<string, unknown>;
type State = { requests: Map<string, Row>; executions: Map<string, Row>; data: Map<string, string> };
interface FakeTransaction extends PrismaExecutionTransactionClient { data: Map<string, string> }

function database() {
  let state: State = { requests: new Map(), executions: new Map(), data: new Map([['subject-1', 'original']]) };
  let abort: unknown;
  const calls: Array<{ query: string; values: unknown[] }> = [];
  let transactions = 0;
  let options: unknown;
  function delegates(current: () => State): FakeTransaction {
    const dataSubjectRequest: PrismaDataSubjectRequestDelegate = {
      async create({ data }) {
        if (current().requests.has(String(data.id))) throw { code: 'P2002' };
        current().requests.set(String(data.id), JSON.parse(JSON.stringify(data)) as Row);
        return data;
      },
      async findUnique({ where }) {
        const row = current().requests.get(where.id);
        return row?.tenantId === where.tenantId ? structuredClone(row) : null;
      },
      async update({ where, data }) {
        const row = current().requests.get(where.id);
        if (row?.tenantId !== where.tenantId) throw { code: 'P2025' };
        Object.assign(row, JSON.parse(JSON.stringify(data)) as Row);
        return row;
      },
      async findMany() { return [...current().requests.values()].map((row) => structuredClone(row)); },
    };
    const dataSubjectExecution: PrismaExecutionDelegate = {
      async create({ data }) {
        if (current().executions.has(data.requestId) || [...current().executions.values()].some((row) =>
          row.tenantId === data.tenantId && row.type === data.type && row.idempotencyKey === data.idempotencyKey)) {
          throw { code: 'P2002' };
        }
        current().executions.set(data.requestId, structuredClone(data));
        return data;
      },
      async findUnique({ where }) {
        if ('requestId' in where) {
          const row = current().executions.get(where.requestId);
          return row?.tenantId === where.tenantId ? structuredClone(row) : null;
        }
        const key = where.tenantId_type_idempotencyKey;
        const row = [...current().executions.values()].find((value) =>
          value.tenantId === key.tenantId && value.type === key.type && value.idempotencyKey === key.idempotencyKey);
        return row ? structuredClone(row) : null;
      },
      async update({ where, data }) {
        const row = current().executions.get(where.requestId);
        if (row?.tenantId !== where.tenantId) throw { code: 'P2025' };
        Object.assign(row, structuredClone(data));
        return row;
      },
    };
    return {
      dataSubjectRequest, dataSubjectExecution,
      get data() { return current().data; },
      async $queryRawUnsafe(query, ...values) {
        calls.push({ query, values });
        if (!query.startsWith('SELECT "requestId", "tenantId"')) return [];
        return [...current().executions.values()]
          .map((row) => row.record as ExecutionRecord)
          .filter((record) => record.artifact?.expiresAt && record.artifact.expiresAt <= String(values[0]) &&
            record.artifact.bodyBase64 != null && record.phase !== 'completed')
          .sort((left, right) => left.artifact!.expiresAt!.localeCompare(right.artifact!.expiresAt!) || left.requestId.localeCompare(right.requestId))
          .slice(0, Number(values[1]))
          .map((record) => ({ requestId: record.requestId, tenantId: record.tenantId }));
      },
    };
  }
  const client: PrismaExecutionClient<FakeTransaction> = {
    ...delegates(() => state),
    async $transaction(work, opts) {
      transactions++;
      options = opts;
      const draft = structuredClone(state);
      const result = await work(delegates(() => draft));
      if (abort) { const error = abort; abort = undefined; throw error; }
      state = draft;
      return result;
    },
  };
  let bound: FakeTransaction | undefined;
  const store = () => new PrismaExecutionStore({
    client,
    async bindTransaction(tx, work) {
      bound = tx;
      try { return await work(); } finally { bound = undefined; }
    },
  });
  return {
    client, store,
    state: () => state,
    bound: () => bound,
    calls,
    transactionCount: () => transactions,
    transactionOptions: () => options,
    failCommit: (error: unknown) => { abort = error; },
  };
}

describe('PrismaExecutionStore transaction contract', () => {
  it('deduplicates after restart, rejects a changed payload, and scopes keys by tenant and type', async () => {
    const db = database();
    expect(await db.store().reserve(request(), 'caller-key', hash)).toMatchObject({ created: true });
    expect(await db.store().reserve(request('ignored-new-id'), 'caller-key', hash))
      .toMatchObject({ created: false, request: { id: 'request-1' } });
    await expect(db.store().reserve(request('another-id'), 'caller-key', 'a'.repeat(64)))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestConflict });
    await db.store().reserve(request('request-2', 'tenant-2'), 'caller-key', hash);
    await db.store().reserve({ ...request('request-3'), type: 'export' }, 'caller-key', hash);
    expect(db.state().requests.size).toBe(3);
    expect(db.state().executions.size).toBe(3);
  });

  it('rolls back request insertion when execution reservation cannot commit', async () => {
    const db = database();
    db.failCommit(new Error('connection lost'));
    await expect(db.store().reserve(request(), 'caller-key', hash)).rejects.toThrow('connection lost');
    expect(db.state().requests.size).toBe(0);
    expect(db.state().executions.size).toBe(0);
    expect(db.transactionCount()).toBe(1);
  });

  it('rolls back bound business rows, request status, and outbox together', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    await expect(store.withLock('request-1', 'tenant-1', async (tx) => {
      db.bound()!.data.delete('subject-1');
      await tx.requests.update('request-1', 'tenant-1', { state: 'processing' });
      tx.record.phase = 'data_committed';
      tx.record.notifications.push({ id: 'event-1', channel: 'outbox', event: 'completed', payload: {}, delivered: false });
      await tx.save(tx.record);
      throw new Error('data verification failed');
    })).rejects.toThrow('data verification failed');
    expect(db.state().data.get('subject-1')).toBe('original');
    expect((await store.requests.findById('request-1', 'tenant-1'))?.state).toBe('created');
    await store.withLock('request-1', 'tenant-1', async (tx) => {
      expect(tx.record.phase).toBe('pending');
      expect(tx.record.notifications).toEqual([]);
    });
  });

  it('persists retry bytes and notifications across store instances, then clears bytes with completion', async () => {
    const db = database();
    await db.store().reserve(request(), 'caller-key', hash);
    await db.store().withLock('request-1', 'tenant-1', async (tx) => {
      db.bound()!.data.delete('subject-1');
      tx.record.phase = 'data_committed';
      tx.record.artifact = { key: 'artifact', bodyBase64: Buffer.from('proof').toString('base64'), hash, contentType: 'application/json' };
      tx.record.notifications = [{ id: 'stable-1', channel: 'audit', event: 'completed', payload: { requestId: 'request-1' }, delivered: false, lastError: 'callback_failed' }];
      await tx.save(tx.record);
      await tx.requests.update('request-1', 'tenant-1', { state: 'processing' });
    });
    await db.store().withLock('request-1', 'tenant-1', async (tx) => {
      expect(tx.record.phase).toBe('data_committed');
      expect(tx.record.notifications[0].id).toBe('stable-1');
      expect(Buffer.from(tx.record.artifact!.bodyBase64!, 'base64').toString()).toBe('proof');
      tx.record.artifact!.bodyBase64 = null;
      tx.record.artifact!.url = 'private://artifact';
      tx.record.phase = 'completed';
      await tx.requests.update('request-1', 'tenant-1', { state: 'completed', artifactUrl: 'private://artifact' });
      await tx.save(tx.record);
    });
    expect(db.state().data.size).toBe(0);
    await db.store().withLock('request-1', 'tenant-1', async (tx) => {
      expect(tx.record.artifact!.bodyBase64).toBeNull();
      expect((await tx.requests.findById('request-1', 'tenant-1'))?.state).toBe('completed');
    });
  });

  it('does not expose another tenant execution and binds SQL values separately', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    const work = jest.fn();
    await expect(store.withLock('request-1', "tenant-2' OR 1=1", work))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
    expect(work).not.toHaveBeenCalled();
    expect(db.calls.at(-1)).toEqual({
      query: 'SELECT "requestId" FROM "DataSubjectExecution" WHERE "requestId" = $1 AND "tenantId" = $2 FOR UPDATE',
      values: ['request-1', "tenant-2' OR 1=1"],
    });
  });

  it('rejects execution identity changes and committed-to-pending regression', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    await expect(store.withLock('request-1', 'tenant-1', (tx) => tx.save({ ...tx.record, tenantId: 'tenant-2' })))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await store.withLock('request-1', 'tenant-1', (tx) => tx.save({ ...tx.record, phase: 'data_committed' }));
    await expect(store.withLock('request-1', 'tenant-1', (tx) => tx.save({ ...tx.record, phase: 'pending' })))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidStateTransition });
  });

  it('retries only known serialization aborts, with Serializable isolation and bounded timeout', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    db.failCommit({ code: 'P2034' });
    const work = jest.fn(async (tx: Parameters<Parameters<typeof store.withLock>[2]>[0]) => {
      db.bound()!.data.delete('subject-1');
      await tx.save({ ...tx.record, phase: 'data_committed' });
    });
    await store.withLock('request-1', 'tenant-1', work);
    expect(work).toHaveBeenCalledTimes(2);
    expect(db.state().data.size).toBe(0);
    expect(db.transactionOptions()).toEqual({ maxWait: 10000, timeout: 30000, isolationLevel: 'Serializable' });
    db.failCommit(new Error('unknown commit outcome'));
    const unknown = jest.fn(async () => undefined);
    await expect(store.withLock('request-1', 'tenant-1', unknown)).rejects.toThrow('unknown commit outcome');
    expect(unknown).toHaveBeenCalledTimes(1);
  });

  it('retries raw PostgreSQL serialization aborts without retrying other raw query failures', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    db.failCommit({ code: 'P2010', meta: { code: '40001', message: 'could not serialize access' } });
    const work = jest.fn(async () => undefined);
    await store.withLock('request-1', 'tenant-1', work);
    expect(work).toHaveBeenCalledTimes(2);
    db.failCommit({ code: 'P2010', meta: { code: '08006', message: 'connection failure' } });
    const unknown = jest.fn(async () => undefined);
    await expect(store.withLock('request-1', 'tenant-1', unknown)).rejects.toMatchObject({ code: 'P2010' });
    expect(unknown).toHaveBeenCalledTimes(1);
  });

  it('bounds default serialization retries and staggers repeated conflicts', async () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    const timer = jest.spyOn(global, 'setTimeout');
    try {
      const db = database();
      const abort = { code: 'P2034' };
      const transaction = jest.fn(async () => { throw abort; });
      db.client.$transaction = transaction;
      const result = db.store().withLock('request-1', 'tenant-1', async () => undefined)
        .catch((error: unknown) => error);
      await jest.runAllTimersAsync();
      expect(await result).toBe(abort);
      expect(transaction).toHaveBeenCalledTimes(8);
      expect(timer.mock.calls.map((call) => call[1])).toEqual([10, 20, 40, 80, 160, 250, 250]);
    } finally {
      timer.mockRestore();
      random.mockRestore();
      jest.useRealTimers();
    }
  });

  it('retries only the observed Prisma 7 adapter serialization SQLSTATE', async () => {
    const db = database();
    const store = db.store();
    await store.reserve(request(), 'caller-key', hash);
    db.failCommit({ code: 'P2010', meta: { driverAdapterError: { cause: {
      originalCode: '40001', kind: 'TransactionWriteConflict',
    } } } });
    const work = jest.fn(async () => undefined);
    await store.withLock('request-1', 'tenant-1', work);
    expect(work).toHaveBeenCalledTimes(2);
    for (const cause of [
      { originalCode: '08006', kind: 'TransactionWriteConflict' },
      { kind: 'TransactionWriteConflict' },
      null,
    ]) {
      db.failCommit({ code: 'P2010', meta: { driverAdapterError: { cause } } });
      const unknown = jest.fn(async () => undefined);
      await expect(store.withLock('request-1', 'tenant-1', unknown)).rejects.toMatchObject({ code: 'P2010' });
      expect(unknown).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects unbounded retry counts, SQL identifiers, and invalid payload hashes before writing', async () => {
    const db = database();
    const opts = { client: db.client, bindTransaction: async <T>(_tx: FakeTransaction, work: () => Promise<T>) => work() };
    expect(() => new PrismaExecutionStore({ ...opts, executionTableName: 'x"; DROP TABLE x' })).toThrow();
    expect(() => new PrismaExecutionStore({ ...opts, executionSchemaName: 'public.bad' })).toThrow();
    expect(() => new PrismaExecutionStore({ ...opts, serializationAttempts: 0 })).toThrow();
    await expect(db.store().reserve(request(), 'caller-key', 'not-a-hash'))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(db.transactionCount()).toBe(0);
  });

  it('qualifies the row lock for Prisma clients with a custom database schema', async () => {
    const db = database();
    const store = new PrismaExecutionStore({
      client: db.client,
      executionSchemaName: 'tenant_data', executionTableName: 'subject_executions',
      bindTransaction: async (_tx, work) => work(),
    });
    await store.reserve(request(), 'caller-key', hash);
    await store.withLock('request-1', 'tenant-1', async () => undefined);
    expect(db.calls[0].query).toContain('FROM "tenant_data"."subject_executions"');
  });

  it('lists bounded expired artifact metadata and skips cleared, completed, future and legacy records', async () => {
    const db = database();
    const store = db.store();
    for (const [id, expiresAt, bodyBase64, phase] of [
      ['expired-a', '2026-01-01T00:00:00.000Z', 'c2VjcmV0', 'data_committed'],
      ['expired-b', '2026-01-01T00:00:00.000Z', 'c2VjcmV0', 'data_committed'],
      ['expired-c', '2026-01-02T00:00:00.000Z', 'c2VjcmV0', 'data_committed'],
      ['future', '2027-01-01T00:00:00.000Z', 'c2VjcmV0', 'data_committed'],
      ['cleared', '2026-01-01T00:00:00.000Z', null, 'data_committed'],
      ['completed', '2026-01-01T00:00:00.000Z', 'c2VjcmV0', 'completed'],
      ['legacy', undefined, 'c2VjcmV0', 'data_committed'],
    ] as const) {
      const tenantId = id === 'expired-c' ? 'tenant-2' : 'tenant-1';
      await store.reserve(request(id, tenantId), `key-${id}`, hash);
      await store.withLock(id, tenantId, async (tx) => {
        await tx.save({ ...tx.record, phase, artifact: { key: id, bodyBase64, hash, contentType: 'application/zip', expiresAt } });
      });
    }
    const now = new Date('2026-02-01T00:00:00Z');
    const firstBatch = await store.listExpiredArtifacts(now, 2);
    expect(firstBatch).toEqual([
      { requestId: 'expired-a', tenantId: 'tenant-1' },
      { requestId: 'expired-b', tenantId: 'tenant-1' },
    ]);
    for (const { requestId, tenantId } of firstBatch) {
      await store.withLock(requestId, tenantId, async (tx) => {
        tx.record.artifact!.bodyBase64 = null;
        await tx.save(tx.record);
      });
    }
    expect(await store.listExpiredArtifacts(now, 2)).toEqual([{ requestId: 'expired-c', tenantId: 'tenant-2' }]);
    expect(db.calls.at(-1)?.values).toEqual(['2026-02-01T00:00:00.000Z', 2]);
    expect(db.calls.at(-1)?.query).toContain('SELECT "requestId", "tenantId"');
    expect(db.calls.at(-1)?.query).not.toContain('SELECT "record"');
    expect(db.state().data.get('subject-1')).toBe('original');
  });

  it('rejects invalid expiry batch limits and dates without opening a transaction', async () => {
    const db = database();
    const store = db.store();
    for (const limit of [0, -1, 1.5, 1001, Infinity]) {
      await expect(store.listExpiredArtifacts(new Date(), limit))
        .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    }
    await expect(store.listExpiredArtifacts(new Date('invalid'), 10))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    expect(db.transactionCount()).toBe(0);
  });
});
