import { DataSubjectError, DataSubjectErrorCode } from '../../src/errors';
import {
  PostgresJobStore, type PostgresJobClient, type PostgresJobTransactionClient,
  type PostgresJobStoreOptions,
} from '../../src/jobs/postgres-job-store';
import type { JobStepResult, JobSubmitInput } from '../../src/jobs/types';

type Row = Record<string, unknown>;
type State = { jobs: Map<string, Row>; chunks: Map<string, Uint8Array>; business: number };
interface Transaction extends PostgresJobTransactionClient { data: State }

/** Contract double only. Lock/crash/Prisma SQL behavior is covered by the PostgreSQL compatibility fixture. */
function database(options: Partial<PostgresJobStoreOptions<Transaction>> = {}) {
  let state: State = { jobs: new Map(), chunks: new Map(), business: 0 };
  let now = new Date('2026-10-11T00:00:00Z');
  let commitError: { error: unknown; afterCommit: boolean } | undefined;
  let rollbackHook: (() => void) | undefined;
  let bound: Transaction | undefined;
  const calls: Array<{ query: string; values: unknown[] }> = [];
  let transactions = 0;
  function project(row: Row): Row {
    return { ...structuredClone(row), expired: (row.expiresAt as Date).getTime() <= now.getTime() };
  }
  function query(current: () => State): PostgresJobTransactionClient['$queryRawUnsafe'] {
    return async (sql, ...values) => {
      calls.push({ query: sql, values });
      const operation = /dsr:job:([a-z-]+)/.exec(sql)?.[1];
      const data = current();
      const [id, tenant] = values;
      const scoped = data.jobs.get(String(id));
      const job = scoped?.tenantId === tenant ? scoped : undefined;
      const ready = [...data.jobs.values()].filter((row) => row.state === 'queued' &&
        (row.availableAt as Date).getTime() <= now.getTime());
      switch (operation) {
        case 'submit': {
          if ([...data.jobs.values()].some((row) => row.tenantId === values[1] && row.kind === values[2] && row.idempotencyKey === values[3])) return [];
          if (data.jobs.has(String(id))) throw { code: 'P2002' };
          const row: Row = {
            id, tenantId: tenant, kind: values[2], idempotencyKey: values[3], payloadHash: values[4],
            payload: JSON.parse(String(values[5])), state: 'queued', checkpoint: null, result: null,
            processedRows: 0, pagesCommitted: 0, chunksWritten: 0, attempts: 0, revision: 0,
            hasCommittedChanges: false, lastError: null, createdAt: now, updatedAt: now, availableAt: now,
            completedAt: null, chunksDeletedAt: null, expiresAt: new Date(now.getTime() + Number(values[6])), purgedAt: null,
          };
          data.jobs.set(String(id), structuredClone(row));
          return [project(row)];
        }
        case 'existing': return [...data.jobs.values()].filter((row) =>
          row.tenantId === values[0] && row.kind === values[1] && row.idempotencyKey === values[2]).map(project);
        case 'get': case 'lock': case 'readable': return job ? [project(job)] : [];
        case 'claim': return ready.filter((row) => (values[0] === null || row.kind === values[0]) &&
          (values[1] === null || row.tenantId === values[1]))
          .sort((a, b) => (a.availableAt as Date).getTime() - (b.availableAt as Date).getTime() || String(a.id).localeCompare(String(b.id)))
          .slice(0, 1).map(project);
        case 'chunk-write': {
          const key = `${id}:${values[2]}`;
          if (data.chunks.has(key)) throw new Error('duplicate chunk');
          data.chunks.set(key, Uint8Array.from(values[3] as Buffer));
          return [{ index: values[2] }];
        }
        case 'chunk-read': {
          const body = data.chunks.get(`${id}:${values[2]}`);
          return job && job.state === 'completed' && job.chunksDeletedAt === null &&
            (job.expiresAt as Date).getTime() > now.getTime() && body ? [{ index: values[2], body: Uint8Array.from(body) }] : [];
        }
        case 'expired': return [...data.jobs.values()].filter((row) =>
          (row.expiresAt as Date).getTime() <= now.getTime() && row.purgedAt === null)
          .sort((a, b) => (a.expiresAt as Date).getTime() - (b.expiresAt as Date).getTime() || String(a.id).localeCompare(String(b.id)))
          .slice(0, Number(id)).map(project);
        case 'chunk-delete': {
          if (!job) return [{ deleted: 0 }];
          const keys = [...data.chunks.keys()].filter((key) => key.startsWith(`${id}:`)).slice(0, 1000);
          for (const key of keys) data.chunks.delete(key);
          return [{ deleted: keys.length }];
        }
        default: {
          if (!job) return [];
          if (operation === 'page') {
            if ((job.expiresAt as Date).getTime() <= now.getTime()) return [];
            Object.assign(job, {
              state: values[2], checkpoint: JSON.parse(String(values[3])), processedRows: values[4],
              pagesCommitted: Number(job.pagesCommitted) + 1, chunksWritten: Number(job.chunksWritten) + Number(values[5]),
              hasCommittedChanges: values[6], attempts: 0, lastError: null, availableAt: now,
              completedAt: values[2] === 'completed' ? now : null, result: JSON.parse(String(values[7])),
            });
          } else if (operation === 'cancel') Object.assign(job, { state: 'cancelled', completedAt: now });
          else if (operation === 'retry') Object.assign(job, { state: 'queued', attempts: 0, lastError: null, availableAt: now, completedAt: null });
          else if (operation === 'chunk-discard') Object.assign(job, { chunksDeletedAt: now });
          else if (operation === 'purge') Object.assign(job, {
            state: job.state === 'queued' ? 'failed' : job.state,
            lastError: job.state === 'queued' ? 'dsr_artifact_expired' : job.lastError,
            completedAt: job.completedAt ?? now, payload: null, checkpoint: null, result: null, chunksDeletedAt: now, purgedAt: values[2] ? now : null,
          });
          else if (operation === 'failure') {
            const exhausted = Number(job.attempts) + 1 >= Number(values[2]);
            Object.assign(job, { attempts: Number(job.attempts) + 1, state: exhausted ? 'failed' : 'queued',
              lastError: values[3], availableAt: new Date(now.getTime() + Number(values[4])), completedAt: exhausted ? now : null });
          } else throw new Error(`unknown operation ${operation}`);
          Object.assign(job, { updatedAt: now, revision: Number(job.revision) + 1 });
          return [project(job)];
        }
      }
    };
  }
  const client: PostgresJobClient<Transaction> = {
    $queryRawUnsafe: query(() => state),
    async $transaction(work) {
      transactions++;
      const draft = structuredClone(state);
      let result;
      try { result = await work({ $queryRawUnsafe: query(() => draft), data: draft }); }
      catch (error) { const hook = rollbackHook; rollbackHook = undefined; hook?.(); throw error; }
      if (commitError) {
        const failure = commitError; commitError = undefined;
        if (failure.afterCommit) state = draft;
        throw failure.error;
      }
      state = draft;
      return result;
    },
  };
  const base: PostgresJobStoreOptions<Transaction> = {
    client,
    async bindTransaction(transaction, work) {
      bound = transaction;
      try { return await work(); } finally { bound = undefined; }
    },
    ...options,
  };
  const store = new PostgresJobStore(base);
  return {
    client, store, calls, base, state: () => state, bound: () => bound,
    advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); },
    failCommit: (error: unknown, afterCommit = false) => { commitError = { error, afterCommit }; },
    afterRollback: (hook: () => void) => { rollbackHook = hook; },
    transactions: () => transactions,
  };
}

function input(id = 'job-1', tenantId = 'tenant-1', payload: JobSubmitInput['payload'] = { subjectId: 'subject-1' }): JobSubmitInput {
  return { id, tenantId, kind: 'privacy', idempotencyKey: 'external-request-1', payload };
}
function step(overrides: Partial<JobStepResult> = {}): JobStepResult {
  return { done: false, checkpoint: { after: 'row-2' }, processedRows: 2, ...overrides };
}
async function chunks(store: PostgresJobStore<Transaction>, id = 'job-1', tenant = 'tenant-1'): Promise<string[]> {
  const output: string[] = [];
  for await (const chunk of store.readChunks(id, tenant)) output.push(chunk.body.toString());
  return output;
}

describe('PostgresJobStore bounded transactional contract', () => {
  it('deduplicates canonical payloads across restarts and scopes keys by tenant/kind', async () => {
    const db = database();
    expect(await db.store.submit(input('job-1', 'tenant-1', { z: 1, a: 2 }))).toMatchObject({ created: true });
    expect(await new PostgresJobStore(db.base).submit(input('unused', 'tenant-1', { a: 2, z: 1 })))
      .toMatchObject({ created: false, job: { id: 'job-1' } });
    await expect(db.store.submit(input('other', 'tenant-1', { z: 3, a: 2 })))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestConflict });
    await db.store.submit(input('job-2', 'tenant-2'));
    await db.store.submit({ ...input('job-3'), kind: 'different' });
    expect(db.state().jobs.size).toBe(3);
  });

  it('preserves __proto__ data in payload identity and snapshots caller mutation', async () => {
    const db = database();
    const payload = JSON.parse('{"__proto__":{"private":"one"},"z":2}') as JobSubmitInput['payload'];
    await db.store.submit(input('job-1', 'tenant-1', payload));
    await expect(db.store.submit(input('other', 'tenant-1', JSON.parse('{"__proto__":{"private":"two"},"z":2}'))))
      .rejects.toMatchObject({ code: DataSubjectErrorCode.RequestConflict });
    const found = await db.store.get('job-1', 'tenant-1');
    expect(Object.hasOwn(found!.payload as object, '__proto__')).toBe(true);
    (found!.payload as Record<string, unknown>).z = 999;
    expect((await db.store.get('job-1', 'tenant-1'))!.payload).toMatchObject({ z: 2 });
  });

  it('commits bound business data, cursor and bytes together and streams one chunk per read', async () => {
    const db = database();
    await db.store.submit(input());
    const buffer = Buffer.from('first\n');
    expect(await db.store.runNext(async ({ appendChunk }) => {
      db.bound()!.data.business += 2;
      await appendChunk(buffer);
      buffer.fill('x');
      return step({ hasCommittedChanges: true });
    })).toMatchObject({ pagesCommitted: 1, processedRows: 2, chunksWritten: 1, hasCommittedChanges: true });
    const done = await db.store.runNext(async ({ job, appendChunk }) => {
      expect(job.checkpoint).toEqual({ after: 'row-2' });
      await appendChunk(Buffer.from('second\n'));
      return step({ done: true, processedRows: 1, result: { rows: 3 } });
    });
    expect(done).toMatchObject({ state: 'completed', processedRows: 3, pagesCommitted: 2, chunksWritten: 2 });
    expect(db.state().business).toBe(2);
    expect(await chunks(db.store)).toEqual(['first\n', 'second\n']);
    expect(db.calls.filter((call) => call.query.includes('dsr:job:chunk-read'))).toHaveLength(2);
    expect(await db.store.runNext(async () => step())).toBeNull();
  });

  it('rolls back failed business mutations and chunks, then backs off with a sanitized error', async () => {
    const db = database();
    await db.store.submit(input());
    expect(await db.store.runNext(async ({ appendChunk }) => {
      db.bound()!.data.business = 99;
      await appendChunk(Buffer.from('private-data'));
      throw new Error('secret@example.com');
    })).toMatchObject({ state: 'queued', attempts: 1, pagesCommitted: 0, processedRows: 0, checkpoint: null, lastError: 'dsr_job_step_failed' });
    expect(db.state().business).toBe(0);
    expect(db.state().chunks.size).toBe(0);
    expect(await db.store.runNext(async () => step())).toBeNull();
    db.advance(1000);
    expect(await db.store.runNext(async () => step({ done: true }))).toMatchObject({ state: 'completed', attempts: 0, lastError: null });
    expect(JSON.stringify(await db.store.get('job-1', 'tenant-1'))).not.toContain('secret@example.com');
  });

  it('stops after bounded consecutive failures and resumes only explicitly', async () => {
    const db = database({ maxAttempts: 2, retryDelayMs: 10 });
    await db.store.submit(input());
    const fail = async () => { throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch, 'private explanation'); };
    await db.store.runNext(fail);
    db.advance(10);
    expect(await db.store.runNext(fail)).toMatchObject({ state: 'failed', attempts: 2, lastError: DataSubjectErrorCode.PlanMismatch });
    db.advance(10_000);
    expect(await db.store.runNext(async () => step())).toBeNull();
    expect(await db.store.retry('job-1', 'tenant-1')).toMatchObject({ state: 'queued', attempts: 0 });
    expect(await db.store.runNext(async () => step({ done: true }))).toMatchObject({ state: 'completed' });
    await expect(db.store.retry('job-1', 'tenant-1')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidStateTransition });
  });

  it('reports cancellation after committed mutations as partial and resumes from the same checkpoint', async () => {
    const db = database();
    await db.store.submit(input());
    await db.store.runNext(async () => step({ hasCommittedChanges: true }));
    expect(await db.store.cancel('job-1', 'tenant-1')).toMatchObject({ state: 'cancelled', partial: true, processedRows: 2 });
    expect(await db.store.runNext(async () => step())).toBeNull();
    expect(await db.store.retry('job-1', 'tenant-1')).toMatchObject({ state: 'queued', partial: false, checkpoint: { after: 'row-2' } });
  });

  it('does not label retained/export scope rows as committed destructive changes', async () => {
    const db = database();
    await db.store.submit(input());
    await db.store.runNext(async () => step());
    expect(await db.store.cancel('job-1', 'tenant-1')).toMatchObject({ partial: false, processedRows: 2 });
  });

  it('scopes all public reads and writes by tenant and supports worker filters', async () => {
    const db = database({ schemaName: 'custom_schema' });
    await db.store.submit(input());
    expect(await db.store.get('job-1', 'wrong')).toBeNull();
    await expect(db.store.cancel('job-1', 'wrong')).rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
    await expect(db.store.retry('job-1', 'wrong')).rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
    await expect(chunks(db.store, 'job-1', 'wrong')).rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
    expect(await db.store.runNext(async () => step(), { tenantId: 'wrong' })).toBeNull();
    expect(await db.store.runNext(async () => step(), { kind: 'wrong' })).toBeNull();
    await db.store.runNext(async () => step({ done: true }), { kind: 'privacy', tenantId: 'tenant-1' });
    expect(db.calls.some((call) => call.query.includes('"custom_schema"."DataSubjectJob"'))).toBe(true);
    expect(db.calls.find((call) => call.query.includes('dsr:job:claim'))!.query).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('does not overwrite a newer successful page after another worker wins the failure race', async () => {
    const db = database();
    await db.store.submit(input());
    db.afterRollback(() => {
      const current = db.state().jobs.get('job-1')!;
      Object.assign(current, { revision: 1, checkpoint: { after: 'winner' }, pagesCommitted: 1, processedRows: 7 });
    });
    expect(await db.store.runNext(async () => { throw new Error('loser'); }))
      .toMatchObject({ attempts: 0, checkpoint: { after: 'winner' }, processedRows: 7, revision: 1 });
  });

  it.each([
    { code: 'P2034' },
    { code: 'P2010', meta: { code: '40001' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001' } } } },
  ])('retries known serialization aborts with atomic rollback: %p', async (error) => {
    const db = database();
    await db.store.submit(input());
    db.failCommit(error);
    const handler = jest.fn(async () => { db.bound()!.data.business++; return step({ done: true }); });
    await db.store.runNext(handler);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(db.state().business).toBe(1);
    expect((await db.store.get('job-1', 'tenant-1'))!.pagesCommitted).toBe(1);
  });

  it.each([
    new Error('connection lost'),
    { code: 'P2010', meta: { code: '23505' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: 'other' } } } },
  ])('does not retry or record failed status for an unknown commit outcome: %p', async (error) => {
    const db = database();
    await db.store.submit(input());
    db.failCommit(error, true);
    const handler = jest.fn(async () => { db.bound()!.data.business++; return step({ done: true }); });
    await expect(db.store.runNext(handler)).rejects.toEqual(error);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await db.store.get('job-1', 'tenant-1')).toMatchObject({ state: 'completed', attempts: 0, pagesCommitted: 1 });
  });

  it('rejects oversize/duplicate chunks and invalid result JSON before committing any business work', async () => {
    const db = database({ maxChunkBytes: 3, retryDelayMs: 1 });
    await db.store.submit(input());
    expect(await db.store.runNext(async ({ appendChunk }) => {
      db.bound()!.data.business = 1;
      await appendChunk(Buffer.from('four'));
      return step();
    })).toMatchObject({ lastError: DataSubjectErrorCode.InvalidInput, pagesCommitted: 0 });
    db.advance(1);
    expect(await db.store.runNext(async ({ appendChunk }) => {
      await appendChunk(Buffer.from('a'));
      await appendChunk(Buffer.from('b'));
      return step();
    })).toMatchObject({ lastError: DataSubjectErrorCode.InvalidInput, pagesCommitted: 0 });
    db.advance(2);
    expect(await db.store.runNext(async () => step({ checkpoint: undefined as never })))
      .toMatchObject({ lastError: DataSubjectErrorCode.InvalidInput, pagesCommitted: 0 });
    expect(db.state().business).toBe(0);
    expect(db.state().chunks.size).toBe(0);
  });

  it('marks deletion permanently and rejects a resume that would skip removed chunks', async () => {
    const db = database();
    await db.store.submit(input());
    await db.store.runNext(async ({ appendChunk }) => { await appendChunk(Buffer.from('one')); return step(); });
    await expect(db.store.deleteChunks('job-1', 'tenant-1')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidStateTransition });
    await db.store.cancel('job-1', 'tenant-1');
    await db.store.deleteChunks('job-1', 'tenant-1');
    await db.store.deleteChunks('job-1', 'tenant-1');
    expect(db.state().chunks.size).toBe(0);
    await expect(db.store.retry('job-1', 'tenant-1')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidStateTransition });
    await expect(chunks(db.store)).rejects.toMatchObject({ code: DataSubjectErrorCode.ArtifactExpired });
  });

  it('enforces immutable expiry, purges bounded pages and retains only dedupe metadata', async () => {
    const db = database({ retentionMs: 100 });
    const submitted = await db.store.submit(input());
    await db.store.runNext(async ({ appendChunk }) => { await appendChunk(Buffer.from('private')); return step({ done: true }); });
    await db.store.submit(input('job-2', 'tenant-2'));
    db.advance(101);
    await expect(chunks(db.store)).rejects.toMatchObject({ code: DataSubjectErrorCode.ArtifactExpired });
    await expect(db.store.retry('job-2', 'tenant-2')).rejects.toMatchObject({ code: DataSubjectErrorCode.ArtifactExpired });
    expect(await db.store.purgeExpiredChunks(1)).toBe(1);
    expect(await db.store.get('job-1', 'tenant-1')).toMatchObject({ payload: null, checkpoint: null, result: null, state: 'completed' });
    expect(db.state().chunks.size).toBe(0);
    const replay = await db.store.submit(input('different-id'));
    expect(replay).toMatchObject({ created: false, job: { id: 'job-1', expiresAt: submitted.job.expiresAt, payload: null } });
    expect(await db.store.purgeExpiredChunks()).toBe(1);
    expect(await db.store.get('job-2', 'tenant-2')).toMatchObject({ state: 'failed', lastError: DataSubjectErrorCode.ArtifactExpired, payload: null });
    expect(await db.store.purgeExpiredChunks()).toBe(0);
  });

  it('never invokes an expired job and rolls back a page that crosses its deadline', async () => {
    const db = database({ retentionMs: 1 });
    await db.store.submit(input());
    db.advance(2);
    const handler = jest.fn(async () => step());
    expect(await db.store.runNext(handler)).toMatchObject({ state: 'failed', lastError: DataSubjectErrorCode.ArtifactExpired, payload: null });
    expect(handler).not.toHaveBeenCalled();
    await db.store.submit(input('job-2', 'tenant-2'));
    expect(await db.store.runNext(async () => {
      db.bound()!.data.business++;
      db.advance(2);
      return step({ hasCommittedChanges: true });
    })).toMatchObject({ state: 'failed', partial: false, pagesCommitted: 0, payload: null });
    expect(db.state().business).toBe(0);
  });

  it('bounds expired cleanup to 1000 chunks per job and keeps incomplete sweeps discoverable', async () => {
    const db = database({ retentionMs: 1 });
    await db.store.submit(input());
    for (let index = 0; index < 2500; index++) db.state().chunks.set(`job-1:${index}`, Buffer.from('row'));
    db.advance(2);
    expect(await db.store.purgeExpiredChunks(1)).toBe(1);
    expect(db.state().chunks.size).toBe(1500);
    expect(await db.store.get('job-1', 'tenant-1')).toMatchObject({ payload: null, purgedAt: null });
    expect(await db.store.purgeExpiredChunks(1)).toBe(1);
    expect(db.state().chunks.size).toBe(500);
    expect(await db.store.purgeExpiredChunks(1)).toBe(1);
    expect(db.state().chunks.size).toBe(0);
    expect((await db.store.get('job-1', 'tenant-1'))!.purgedAt).not.toBeNull();
    expect(await db.store.purgeExpiredChunks(1)).toBe(0);
    expect(db.calls.filter((call) => call.query.includes('dsr:job:chunk-delete')).every((call) =>
      call.query.includes('LIMIT 1000') && call.query.includes('count(*)::integer'))).toBe(true);
  });

  it('manually clears a large cancelled export in separate bounded transactions', async () => {
    const db = database();
    await db.store.submit(input());
    await db.store.cancel('job-1', 'tenant-1');
    for (let index = 0; index < 2500; index++) db.state().chunks.set(`job-1:${index}`, Buffer.from('row'));
    const before = db.transactions();
    await db.store.deleteChunks('job-1', 'tenant-1');
    expect(db.state().chunks.size).toBe(0);
    expect(db.transactions() - before).toBe(3);
    await expect(db.store.retry('job-1', 'tenant-1')).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidStateTransition });
  });

  it('rejects invalid identifiers, JSON, limits and SQL identifier interpolation', async () => {
    const db = database();
    for (const payload of [undefined, NaN, new Date(), { x: undefined }, [undefined]]) {
      await expect(db.store.submit({ ...input('job', 'tenant'), payload: payload as never })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    await expect(db.store.submit(input('job', 'tenant', cyclic as never))).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await expect(db.store.submit({ ...input(), id: '' })).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    await expect(db.store.purgeExpiredChunks(1001)).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
    for (const opts of [{ schemaName: 'public;DROP' }, { maxAttempts: 0 }, { retryDelayMs: -1 }, { retentionMs: Infinity }, { maxJsonBytes: 0 }]) {
      expect(() => new PostgresJobStore({ ...db.base, ...opts })).toThrow(DataSubjectError);
    }
  });
});
