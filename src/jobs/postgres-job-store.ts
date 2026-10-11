import { createHash } from 'node:crypto';
import { isDate, isUint8Array } from 'node:util/types';
import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type {
  DurableJobStore, JobFilter, JobHandler, JobJson, JobRecord, JobStepResult, JobSubmitInput,
} from './types';

export interface PostgresJobTransactionClient {
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface PostgresJobClient<TTransaction extends PostgresJobTransactionClient>
extends PostgresJobTransactionClient {
  $transaction<T>(
    work: (transaction: TTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: 'Serializable' },
  ): Promise<T>;
}

export interface PostgresJobStoreOptions<TTransaction extends PostgresJobTransactionClient> {
  client: PostgresJobClient<TTransaction>;
  /** Route every local business delegate to this transaction, e.g. through AsyncLocalStorage. */
  bindTransaction<T>(transaction: TTransaction, work: () => Promise<T>): Promise<T>;
  tableName?: string;
  chunkTableName?: string;
  schemaName?: string;
  transactionOptions?: { maxWait?: number; timeout?: number };
  serializationAttempts?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  maxChunkBytes?: number;
  maxJsonBytes?: number;
  /** Immutable retention deadline for queued/terminal payloads and chunks; default seven days. */
  retentionMs?: number;
}

/**
 * One bounded page holds a PostgreSQL row lock. A crash rolls back both the page
 * and its checkpoint. SKIP LOCKED lets other workers continue unrelated jobs.
 * External I/O is not transactionally protected and requires its own idempotency.
 */
export class PostgresJobStore<TTransaction extends PostgresJobTransactionClient>
implements DurableJobStore {
  private readonly table: string;
  private readonly chunks: string;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxChunkBytes: number;
  private readonly maxJsonBytes: number;
  private readonly serializationAttempts: number;
  private readonly retentionMs: number;

  constructor(private readonly opts: PostgresJobStoreOptions<TTransaction>) {
    this.table = qualified(opts.tableName ?? 'DataSubjectJob', opts.schemaName);
    this.chunks = qualified(opts.chunkTableName ?? 'DataSubjectJobChunk', opts.schemaName);
    if (typeof opts.bindTransaction !== 'function') invalid('bindTransaction is required');
    this.maxAttempts = bounded(opts.maxAttempts ?? 5, 1, 100, 'maxAttempts');
    this.retryDelayMs = bounded(opts.retryDelayMs ?? 1000, 1, 3_600_000, 'retryDelayMs');
    this.maxChunkBytes = bounded(opts.maxChunkBytes ?? 8 * 1024 * 1024, 1, 64 * 1024 * 1024, 'maxChunkBytes');
    this.maxJsonBytes = bounded(opts.maxJsonBytes ?? 256 * 1024, 1, 1024 * 1024, 'maxJsonBytes');
    this.serializationAttempts = bounded(opts.serializationAttempts ?? 8, 1, 10, 'serializationAttempts');
    this.retentionMs = bounded(opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000, 1, 365 * 24 * 60 * 60 * 1000, 'retentionMs');
    if (opts.transactionOptions?.timeout !== undefined) {
      bounded(opts.transactionOptions.timeout, 1, 300_000, 'transaction timeout');
    }
    if (opts.transactionOptions?.maxWait !== undefined) {
      bounded(opts.transactionOptions.maxWait, 1, 60_000, 'transaction maxWait');
    }
  }

  async submit(input: JobSubmitInput): Promise<{ job: JobRecord; created: boolean }> {
    identifier(input.id, 'id');
    identifier(input.tenantId, 'tenantId');
    identifier(input.kind, 'kind');
    identifier(input.idempotencyKey, 'idempotencyKey');
    const payload = json(input.payload, this.maxJsonBytes);
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(async (client) => {
      const created = rows(await client.$queryRawUnsafe(`/* dsr:job:submit */
INSERT INTO ${this.table} ("id", "tenantId", "kind", "idempotencyKey", "payloadHash", "payload", "expiresAt")
VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp() + ($7::double precision * INTERVAL '1 millisecond'))
ON CONFLICT ("tenantId", "kind", "idempotencyKey") DO NOTHING RETURNING *`,
      input.id, input.tenantId, input.kind, input.idempotencyKey, payloadHash, payload, this.retentionMs));
      if (created.length) return { job: decode(created[0]), created: true };
      const existing = rows(await client.$queryRawUnsafe(`/* dsr:job:existing */
SELECT * FROM ${this.table} WHERE "tenantId" = $1 AND "kind" = $2 AND "idempotencyKey" = $3`,
      input.tenantId, input.kind, input.idempotencyKey));
      if (!existing.length) throw new Error('job reservation outcome unavailable');
      const job = decode(existing[0]);
      if (job.payloadHash !== payloadHash) {
        throw new DataSubjectError(DataSubjectErrorCode.RequestConflict, 'job key has a different payload');
      }
      return { job, created: false };
    });
  }

  async get(id: string, tenantId: string): Promise<JobRecord | null> {
    identifier(id, 'id');
    identifier(tenantId, 'tenantId');
    const found = rows(await this.opts.client.$queryRawUnsafe(`/* dsr:job:get */
SELECT * FROM ${this.table} WHERE "id" = $1 AND "tenantId" = $2`, id, tenantId));
    return found.length ? decode(found[0]) : null;
  }

  async cancel(id: string, tenantId: string): Promise<JobRecord> {
    return this.withJob(id, tenantId, async (client, job) => {
      if (job.state === 'completed' || job.state === 'cancelled') return job;
      return decodeOne(await client.$queryRawUnsafe(`/* dsr:job:cancel */
UPDATE ${this.table} SET "state" = 'cancelled', "revision" = "revision" + 1,
"updatedAt" = clock_timestamp(), "completedAt" = clock_timestamp()
WHERE "id" = $1 AND "tenantId" = $2 RETURNING *`, id, tenantId));
    });
  }

  async retry(id: string, tenantId: string): Promise<JobRecord> {
    return this.withJob(id, tenantId, async (client, job, expired) => {
      if (expired || job.purgedAt !== null) throw new DataSubjectError(DataSubjectErrorCode.ArtifactExpired);
      if (job.state === 'queued') return job;
      if (!['failed', 'cancelled'].includes(job.state) || job.chunksDeletedAt !== null) {
        throw new DataSubjectError(DataSubjectErrorCode.InvalidStateTransition, 'job cannot resume');
      }
      return decodeOne(await client.$queryRawUnsafe(`/* dsr:job:retry */
UPDATE ${this.table} SET "state" = 'queued', "attempts" = 0, "lastError" = NULL,
"revision" = "revision" + 1, "updatedAt" = clock_timestamp(),
"availableAt" = clock_timestamp(), "completedAt" = NULL
WHERE "id" = $1 AND "tenantId" = $2 RETURNING *`, id, tenantId));
    });
  }

  async runNext(handler: JobHandler, filter: JobFilter = {}): Promise<JobRecord | null> {
    if (typeof handler !== 'function') invalid('handler must be a function');
    if (filter.kind !== undefined) identifier(filter.kind, 'kind');
    if (filter.tenantId !== undefined) identifier(filter.tenantId, 'tenantId');
    let failed: { job: JobRecord; error: unknown } | undefined;
    try {
      return await this.transaction(async (client) => {
        failed = undefined;
        const selected = rows(await client.$queryRawUnsafe(`/* dsr:job:claim */
SELECT *, ("expiresAt" <= clock_timestamp()) AS "expired" FROM ${this.table}
WHERE "state" = 'queued' AND "availableAt" <= clock_timestamp()
AND ($1::text IS NULL OR "kind" = $1) AND ($2::text IS NULL OR "tenantId" = $2)
ORDER BY "availableAt", "createdAt", "id" LIMIT 1 FOR UPDATE SKIP LOCKED`,
        filter.kind ?? null, filter.tenantId ?? null));
        if (!selected.length) return null;
        const job = decode(selected[0]);
        if (object(selected[0]).expired === true) return this.purgeOne(client, job);
        let chunk: Buffer | undefined;
        let acceptingChunk = true;
        let step: JobStepResult;
        try {
          step = await this.opts.bindTransaction(client, () => handler({
            job: structuredClone(job),
            appendChunk: async (body) => {
              if (!acceptingChunk || chunk !== undefined || !Buffer.isBuffer(body) || body.length > this.maxChunkBytes) {
                invalid('one bounded Buffer chunk is allowed per page');
              }
              // Snapshot immediately; callers must not mutate bytes after scheduling append.
              chunk = Buffer.from(body);
            },
          }));
          acceptingChunk = false;
          validateStep(step);
          const checkpoint = json(step.checkpoint, this.maxJsonBytes);
          const result = json(step.result ?? null, this.maxJsonBytes);
          const processedRows = job.processedRows + step.processedRows;
          if (!Number.isSafeInteger(processedRows)) invalid('processed row count exceeds the safe integer range');
          if (chunk !== undefined) {
            await client.$queryRawUnsafe(`/* dsr:job:chunk-write */
INSERT INTO ${this.chunks} ("jobId", "tenantId", "index", "body") VALUES ($1, $2, $3, $4) RETURNING "index"`,
            job.id, job.tenantId, job.chunksWritten, chunk);
          }
          return decodeOne(await client.$queryRawUnsafe(`/* dsr:job:page */
UPDATE ${this.table} SET "state" = $3, "checkpoint" = $4::jsonb,
"processedRows" = $5::bigint, "pagesCommitted" = "pagesCommitted" + 1,
"chunksWritten" = "chunksWritten" + $6::integer, "hasCommittedChanges" = $7,
"attempts" = 0, "lastError" = NULL, "revision" = "revision" + 1,
"updatedAt" = clock_timestamp(), "availableAt" = clock_timestamp(),
"completedAt" = CASE WHEN $3 = 'completed' THEN clock_timestamp() ELSE NULL END,
"result" = $8::jsonb
WHERE "id" = $1 AND "tenantId" = $2 AND "expiresAt" > clock_timestamp() RETURNING *`,
          job.id, job.tenantId, step.done ? 'completed' : 'queued', checkpoint, processedRows,
          chunk === undefined ? 0 : 1, job.hasCommittedChanges || step.hasCommittedChanges === true, result));
        } catch (error) {
          acceptingChunk = false;
          failed = { job, error };
          throw error;
        }
      });
    } catch (error) {
      // A commit error occurs outside the handler. Its outcome can be unknown;
      // leave the checkpoint to database reconciliation and never mark it failed.
      if (!failed || failed.error !== error || isSerializationAbort(error)) throw error;
      return this.recordFailure(failed.job, error);
    }
  }

  async *readChunks(id: string, tenantId: string): AsyncIterable<{ index: number; body: Buffer }> {
    identifier(id, 'id');
    identifier(tenantId, 'tenantId');
    const metadata = rows(await this.opts.client.$queryRawUnsafe(`/* dsr:job:readable */
SELECT *, ("expiresAt" <= clock_timestamp()) AS "expired" FROM ${this.table}
WHERE "id" = $1 AND "tenantId" = $2`, id, tenantId));
    if (!metadata.length) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
    const job = decode(metadata[0]);
    if (object(metadata[0]).expired === true || job.chunksDeletedAt !== null) throw new DataSubjectError(DataSubjectErrorCode.ArtifactExpired);
    if (job.state !== 'completed') throw new DataSubjectError(DataSubjectErrorCode.InvalidStateTransition, 'job is not complete');
    // One chunk per query bounds memory independently of total exported rows.
    for (let index = 0; index < job.chunksWritten; index++) {
      const found = rows(await this.opts.client.$queryRawUnsafe(`/* dsr:job:chunk-read */
SELECT c."index", c."body" FROM ${this.chunks} c
JOIN ${this.table} j ON j."id" = c."jobId" AND j."tenantId" = c."tenantId"
WHERE c."jobId" = $1 AND c."tenantId" = $2 AND c."index" = $3
AND j."state" = 'completed' AND j."chunksDeletedAt" IS NULL
AND j."expiresAt" > clock_timestamp()`, id, tenantId, index));
      if (found.length !== 1) throw new DataSubjectError(DataSubjectErrorCode.ArtifactExpired, 'export chunk is unavailable');
      const raw = object(found[0]);
      if (raw.index !== index || !isUint8Array(raw.body) || raw.body.byteLength > this.maxChunkBytes) {
        throw new TypeError('invalid job chunk');
      }
      yield { index, body: Buffer.from(raw.body) };
    }
  }

  async deleteChunks(id: string, tenantId: string): Promise<void> {
    let finished = false;
    while (!finished) {
      finished = await this.withJob(id, tenantId, async (client, job) => {
        if (job.state === 'queued') throw new DataSubjectError(DataSubjectErrorCode.InvalidStateTransition, 'cancel the job before cleanup');
        const complete = await this.deleteChunkBatch(client, id, tenantId);
        if (job.chunksDeletedAt === null) await client.$queryRawUnsafe(`/* dsr:job:chunk-discard */
UPDATE ${this.table} SET "chunksDeletedAt" = clock_timestamp(), "updatedAt" = clock_timestamp(),
"revision" = "revision" + 1 WHERE "id" = $1 AND "tenantId" = $2 RETURNING "id"`, id, tenantId);
        return complete;
      });
    }
  }

  async purgeExpiredChunks(limit = 100): Promise<number> {
    bounded(limit, 1, 1000, 'purge limit');
    return this.transaction(async (client) => {
      const expired = rows(await client.$queryRawUnsafe(`/* dsr:job:expired */
SELECT * FROM ${this.table} WHERE "expiresAt" <= clock_timestamp() AND "purgedAt" IS NULL
ORDER BY "expiresAt", "id" LIMIT $1 FOR UPDATE SKIP LOCKED`, limit));
      for (const row of expired) await this.purgeOne(client, decode(row));
      return expired.length;
    });
  }

  private async purgeOne(client: TTransaction, job: JobRecord): Promise<JobRecord> {
    const complete = await this.deleteChunkBatch(client, job.id, job.tenantId);
    return decodeOne(await client.$queryRawUnsafe(`/* dsr:job:purge */
UPDATE ${this.table} SET "state" = CASE WHEN "state" = 'queued' THEN 'failed' ELSE "state" END,
"lastError" = CASE WHEN "state" = 'queued' THEN 'dsr_artifact_expired' ELSE "lastError" END,
"completedAt" = COALESCE("completedAt", clock_timestamp()), "payload" = 'null'::jsonb,
"checkpoint" = 'null'::jsonb, "result" = 'null'::jsonb, "chunksDeletedAt" = clock_timestamp(),
"purgedAt" = CASE WHEN $3 THEN clock_timestamp() ELSE NULL END,
"updatedAt" = clock_timestamp(), "revision" = "revision" + 1
WHERE "id" = $1 AND "tenantId" = $2 RETURNING *`, job.id, job.tenantId, complete));
  }

  private async deleteChunkBatch(client: TTransaction, id: string, tenantId: string): Promise<boolean> {
    // Bound both database work and returned memory, even for a job with millions
    // of chunks. An exactly full batch is checked once more on the next sweep.
    const result = rows(await client.$queryRawUnsafe(`/* dsr:job:chunk-delete */
WITH selected AS (
  SELECT "index" FROM ${this.chunks} WHERE "jobId" = $1 AND "tenantId" = $2 ORDER BY "index" LIMIT 1000
), deleted AS (
  DELETE FROM ${this.chunks} c USING selected
  WHERE c."jobId" = $1 AND c."tenantId" = $2 AND c."index" = selected."index" RETURNING 1
)
SELECT count(*)::integer AS "deleted" FROM deleted`, id, tenantId));
    if (result.length !== 1 || !Number.isInteger(object(result[0]).deleted)) throw new TypeError('invalid chunk cleanup result');
    return Number(object(result[0]).deleted) < 1000;
  }

  private async recordFailure(original: JobRecord, error: unknown): Promise<JobRecord> {
    return this.withJob(original.id, original.tenantId, async (client, current, expired) => {
      // Another worker or cancellation can win after the failed page rolls back.
      // Never overwrite their newer checkpoint or terminal state.
      if (current.revision !== original.revision || current.state !== 'queued') return current;
      if (expired) return this.purgeOne(client, current);
      const code = error instanceof DataSubjectError ? error.code : 'dsr_job_step_failed';
      const delay = Math.min(this.retryDelayMs * 2 ** Math.min(current.attempts, 20), 3_600_000);
      return decodeOne(await client.$queryRawUnsafe(`/* dsr:job:failure */
UPDATE ${this.table} SET "attempts" = "attempts" + 1,
"state" = CASE WHEN "attempts" + 1 >= $3 THEN 'failed' ELSE 'queued' END,
"lastError" = $4, "revision" = "revision" + 1, "updatedAt" = clock_timestamp(),
"availableAt" = clock_timestamp() + ($5::double precision * INTERVAL '1 millisecond'),
"completedAt" = CASE WHEN "attempts" + 1 >= $3 THEN clock_timestamp() ELSE NULL END
WHERE "id" = $1 AND "tenantId" = $2 RETURNING *`,
      original.id, original.tenantId, this.maxAttempts, code, delay));
    });
  }

  private async withJob<T>(id: string, tenantId: string, work: (client: TTransaction, job: JobRecord, expired: boolean) => Promise<T>): Promise<T> {
    identifier(id, 'id');
    identifier(tenantId, 'tenantId');
    return this.transaction(async (client) => {
      const found = rows(await client.$queryRawUnsafe(`/* dsr:job:lock */
SELECT *, ("expiresAt" <= clock_timestamp()) AS "expired" FROM ${this.table} WHERE "id" = $1 AND "tenantId" = $2 FOR UPDATE`, id, tenantId));
      if (!found.length) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
      return work(client, decode(found[0]), object(found[0]).expired === true);
    });
  }

  private async transaction<T>(work: (client: TTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.opts.client.$transaction(work, {
          maxWait: 10_000, timeout: 30_000, ...this.opts.transactionOptions, isolationLevel: 'Serializable',
        });
      } catch (error) {
        if (!isSerializationAbort(error) || attempt >= this.serializationAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** (attempt - 1), 250) + Math.floor(Math.random() * 25)));
      }
    }
  }
}

function invalid(reason: string): never {
  throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, reason);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) invalid(`${label} must contain 1 to 255 characters`);
}

function bounded(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`invalid ${label}`);
  return value;
}

function qualified(table: string, schema?: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) || (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))) {
    invalid('invalid job table or schema name');
  }
  return schema === undefined ? `"${table}"` : `"${schema}"."${table}"`;
}

function validateStep(step: JobStepResult): void {
  if (!step || typeof step.done !== 'boolean' || !Number.isSafeInteger(step.processedRows) || step.processedRows < 0 ||
      (step.hasCommittedChanges !== undefined && typeof step.hasCommittedChanges !== 'boolean')) invalid('invalid job step result');
}

/** Canonical JSON preserves __proto__ keys, rejects lossy values and limits recursion. */
function json(value: unknown, maxBytes: number): string {
  const seen = new Set<object>();
  function encode(item: unknown, depth: number): string {
    if (depth > 64) invalid('job JSON nesting exceeds 64 levels');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || seen.has(item)) invalid('job value must be plain acyclic JSON');
    const prototype = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && prototype !== null && prototype !== Object.prototype && Object.getPrototypeOf(prototype) !== null) {
      invalid('job value must be plain JSON');
    }
    seen.add(item);
    const encoded = Array.isArray(item)
      ? `[${Array.from(item, (entry) => encode(entry, depth + 1)).join(',')}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    seen.delete(item);
    return encoded;
  }
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded) > maxBytes) invalid('job JSON exceeds configured size');
  return encoded;
}

function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError('invalid job database result');
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new TypeError('invalid job database row');
  return value as Record<string, unknown>;
}

function decodeOne(value: unknown): JobRecord {
  const found = rows(value);
  if (found.length !== 1) throw new TypeError('job update outcome unavailable');
  return decode(found[0]);
}

function decode(value: unknown): JobRecord {
  const row = object(value);
  for (const field of ['id', 'tenantId', 'kind', 'idempotencyKey', 'payloadHash', 'state']) {
    if (typeof row[field] !== 'string') throw new TypeError('invalid job identity');
  }
  if (!['queued', 'completed', 'failed', 'cancelled'].includes(row.state as string) || typeof row.hasCommittedChanges !== 'boolean' ||
      (row.lastError !== null && typeof row.lastError !== 'string')) throw new TypeError('invalid job state');
  function count(field: string): number {
    const raw = row[field];
    if (typeof raw !== 'number' && typeof raw !== 'bigint') throw new TypeError('invalid job counter');
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 0) throw new TypeError('invalid job counter');
    return number;
  }
  function date(field: string): Date {
    const raw = row[field];
    if (!isDate(raw) || !Number.isFinite(raw.getTime())) throw new TypeError('invalid job timestamp');
    return new Date(raw);
  }
  return {
    id: row.id as string, tenantId: row.tenantId as string, kind: row.kind as string,
    idempotencyKey: row.idempotencyKey as string, payloadHash: row.payloadHash as string,
    payload: structuredClone(row.payload as JobJson), checkpoint: structuredClone(row.checkpoint as JobJson),
    result: structuredClone(row.result as JobJson), state: row.state as JobRecord['state'],
    processedRows: count('processedRows'), pagesCommitted: count('pagesCommitted'), chunksWritten: count('chunksWritten'),
    attempts: count('attempts'), revision: count('revision'), hasCommittedChanges: row.hasCommittedChanges,
    partial: ['failed', 'cancelled'].includes(row.state as string) && row.hasCommittedChanges,
    lastError: row.lastError as string | null, createdAt: date('createdAt'), updatedAt: date('updatedAt'),
    availableAt: date('availableAt'), completedAt: row.completedAt === null ? null : date('completedAt'),
    chunksDeletedAt: row.chunksDeletedAt === null ? null : date('chunksDeletedAt'),
    expiresAt: date('expiresAt'), purgedAt: row.purgedAt === null ? null : date('purgedAt'),
  };
}

function isSerializationAbort(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  if (error.code === 'P2034') return true;
  if (error.code !== 'P2010' || !('meta' in error) || !error.meta || typeof error.meta !== 'object') return false;
  if ('code' in error.meta && error.meta.code === '40001') return true;
  if (!('driverAdapterError' in error.meta) || !error.meta.driverAdapterError || typeof error.meta.driverAdapterError !== 'object') return false;
  const adapter = error.meta.driverAdapterError;
  return 'cause' in adapter && adapter.cause !== null && typeof adapter.cause === 'object' &&
    'originalCode' in adapter.cause && adapter.cause.originalCode === '40001';
}
