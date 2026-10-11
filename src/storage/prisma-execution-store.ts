import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type { DataSubjectRequest, RequestType } from '../types';
import type {
  DurableExecutionStore,
  ExecutionRecord,
  ExecutionTransaction,
} from './durable-execution-store.interface';
import {
  PrismaRequestStorage,
  type PrismaDataSubjectRequestDelegate,
} from './prisma-request-storage';
import { validateRequestIdentifier, validateRequestIdentity } from './request-storage-validation';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type ExecutionIdentity = {
  tenantId: string;
  type: RequestType;
  idempotencyKey: string;
};

export interface PrismaExecutionDelegate {
  create(args: {
    data: ExecutionIdentity & { requestId: string; payloadHash: string; record: JsonObject };
  }): Promise<unknown>;
  findUnique(args: {
    where:
      | { requestId: string; tenantId: string }
      | { tenantId_type_idempotencyKey: ExecutionIdentity };
  }): Promise<unknown | null>;
  update(args: {
    where: { requestId: string; tenantId: string };
    data: { record: JsonObject };
  }): Promise<unknown>;
}

export interface PrismaExecutionTransactionClient {
  dataSubjectRequest: PrismaDataSubjectRequestDelegate;
  dataSubjectExecution: PrismaExecutionDelegate;
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
}

export interface PrismaExecutionClient<TTransaction extends PrismaExecutionTransactionClient> {
  dataSubjectRequest: PrismaDataSubjectRequestDelegate;
  dataSubjectExecution: PrismaExecutionDelegate;
  $transaction<T>(
    work: (transaction: TTransaction) => Promise<T>,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: 'Serializable' },
  ): Promise<T>;
}

export interface PrismaExecutionStoreOptions<TTransaction extends PrismaExecutionTransactionClient> {
  client: PrismaExecutionClient<TTransaction>;
  /** Required: route every executor to this transaction (for example with AsyncLocalStorage). */
  bindTransaction<T>(transaction: TTransaction, work: () => Promise<T>): Promise<T>;
  /** Increase timeout deliberately for bounded upload/delivery work; never run unbounded jobs. */
  transactionOptions?: { maxWait?: number; timeout?: number };
  /** Known PostgreSQL serialization aborts only; default 8 total attempts with bounded backoff. */
  serializationAttempts?: number;
  /** SQL table name when the Prisma model uses @@map. Schema-qualified names are not accepted. */
  executionTableName?: string;
  /** Set this when the model is outside the connection's default SQL search_path. */
  executionSchemaName?: string;
}

/** PostgreSQL request reservation, row locking, and atomic execution/outbox persistence. */
export class PrismaExecutionStore<TTransaction extends PrismaExecutionTransactionClient>
implements DurableExecutionStore {
  readonly requests: PrismaRequestStorage;
  private readonly lockSql: string;
  private readonly expiredArtifactsSql: string;

  constructor(private readonly opts: PrismaExecutionStoreOptions<TTransaction>) {
    const table = opts.executionTableName ?? 'DataSubjectExecution';
    const schema = opts.executionSchemaName;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table) ||
        (schema !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema))) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'invalid execution table name');
    }
    if (typeof opts.bindTransaction !== 'function') {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'bindTransaction is required');
    }
    if (opts.serializationAttempts !== undefined &&
        (!Number.isInteger(opts.serializationAttempts) || opts.serializationAttempts < 1 || opts.serializationAttempts > 10)) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'serializationAttempts must be between 1 and 10');
    }
    this.requests = new PrismaRequestStorage({ delegate: opts.client.dataSubjectRequest });
    const qualifiedTable = schema === undefined ? `"${table}"` : `"${schema}"."${table}"`;
    this.lockSql = `SELECT "requestId" FROM ${qualifiedTable} WHERE "requestId" = $1 AND "tenantId" = $2 FOR UPDATE`;
    this.expiredArtifactsSql = `SELECT "requestId", "tenantId" FROM ${qualifiedTable}
WHERE "record"->'artifact'->>'expiresAt' <= $1
  AND "record"->'artifact'->>'bodyBase64' IS NOT NULL
  AND "record"->>'phase' <> 'completed'
ORDER BY "record"->'artifact'->>'expiresAt', "requestId"
LIMIT $2`;
  }

  async listExpiredArtifacts(now: Date, limit: number): Promise<Array<{ requestId: string; tenantId: string }>> {
    if (!Number.isFinite(now.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'valid date and artifact limit between 1 and 1000 required');
    }
    const rows = await this.retrySerialization(() => this.opts.client.$transaction(
      (client) => client.$queryRawUnsafe(this.expiredArtifactsSql, now.toISOString(), limit),
      this.transactionOptions(),
    ));
    if (!Array.isArray(rows)) throw new TypeError('invalid expired artifact metadata');
    return rows.map((row: unknown) => {
      if (!row || typeof row !== 'object' || !('requestId' in row) || !('tenantId' in row) ||
          typeof row.requestId !== 'string' || typeof row.tenantId !== 'string') {
        throw new TypeError('invalid expired artifact metadata');
      }
      return { requestId: row.requestId, tenantId: row.tenantId };
    });
  }

  async reserve(
    request: DataSubjectRequest,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ request: DataSubjectRequest; created: boolean }> {
    validateRequestIdentity(request);
    validateRequestIdentifier(idempotencyKey, 'idempotencyKey');
    if (idempotencyKey.length > 255 || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'invalid idempotency key or payload hash');
    }
    const identity: ExecutionIdentity = { tenantId: request.tenantId, type: request.type, idempotencyKey };
    try {
      return await this.retrySerialization(() => this.opts.client.$transaction(async (client) => {
        const prior = await client.dataSubjectExecution.findUnique({
          where: { tenantId_type_idempotencyKey: identity },
        });
        const requests = new PrismaRequestStorage({ delegate: client.dataSubjectRequest });
        if (prior) return this.existing(prior, identity, payloadHash, requests);

        await requests.insert(request);
        const record: ExecutionRecord = {
          requestId: request.id,
          ...identity,
          payloadHash,
          phase: 'pending',
          artifact: null,
          stats: null,
          notifications: [],
        };
        await client.dataSubjectExecution.create({
          data: { requestId: request.id, ...identity, payloadHash, record: toJson(record) },
        });
        return { request: structuredClone(request), created: true };
      }, this.transactionOptions()));
    } catch (error) {
      // A concurrent winner can become visible only after our losing transaction rolls back.
      if (!isUniqueConflict(error)) throw error;
      const prior = await this.opts.client.dataSubjectExecution.findUnique({
        where: { tenantId_type_idempotencyKey: identity },
      });
      if (!prior) throw error;
      return this.existing(prior, identity, payloadHash, this.requests);
    }
  }

  async withLock<T>(
    requestId: string,
    tenantId: string,
    work: (transaction: ExecutionTransaction) => Promise<T>,
  ): Promise<T> {
    validateRequestIdentifier(requestId, 'requestId');
    validateRequestIdentifier(tenantId, 'tenantId');
    return this.retrySerialization(() => this.opts.client.$transaction(async (client) => {
      await client.$queryRawUnsafe(this.lockSql, requestId, tenantId);
      const row = await client.dataSubjectExecution.findUnique({ where: { requestId, tenantId } });
      if (!row) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
      let saved = decodeRecord(row);
      const transaction: ExecutionTransaction = {
        record: structuredClone(saved),
        requests: new PrismaRequestStorage({ delegate: client.dataSubjectRequest }),
        save: async (record) => {
          assertIdentity(saved, record);
          const phases = ['pending', 'data_committed', 'completed'];
          if (phases.indexOf(record.phase) < phases.indexOf(saved.phase)) {
            throw new DataSubjectError(DataSubjectErrorCode.InvalidStateTransition);
          }
          const json = toJson(record);
          await client.dataSubjectExecution.update({
            where: { requestId, tenantId }, data: { record: json },
          });
          saved = structuredClone(record);
          transaction.record = structuredClone(record);
        },
      };
      return this.opts.bindTransaction(client, () => work(transaction));
    }, this.transactionOptions()));
  }

  private transactionOptions() {
    return { maxWait: 10_000, timeout: 30_000, ...this.opts.transactionOptions, isolationLevel: 'Serializable' as const };
  }

  private async retrySerialization<T>(work: () => Promise<T>): Promise<T> {
    const attempts = this.opts.serializationAttempts ?? 8;
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if (!isSerializationAbort(error) || attempt >= attempts) throw error;
        // Stagger duplicate callers so one winner can finish its bounded phases.
        const backoffMs = Math.min(10 * 2 ** (attempt - 1), 250) + Math.floor(Math.random() * 25);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  private async existing(
    row: unknown,
    identity: ExecutionIdentity,
    payloadHash: string,
    requests: PrismaRequestStorage,
  ): Promise<{ request: DataSubjectRequest; created: false }> {
    const record = decodeRecord(row);
    if (record.payloadHash !== payloadHash || record.tenantId !== identity.tenantId ||
        record.type !== identity.type || record.idempotencyKey !== identity.idempotencyKey) {
      throw new DataSubjectError(DataSubjectErrorCode.RequestConflict, 'idempotency key has a different payload');
    }
    const request = await requests.findById(record.requestId, record.tenantId);
    if (!request) throw new DataSubjectError(DataSubjectErrorCode.RequestNotFound);
    return { request, created: false };
  }
}

function toJson(record: ExecutionRecord): JsonObject {
  return JSON.parse(JSON.stringify(record)) as JsonObject;
}

function decodeRecord(row: unknown): ExecutionRecord {
  if (!row || typeof row !== 'object') throw new TypeError('invalid execution row');
  const raw = row as Record<string, unknown>;
  const record = raw.record as ExecutionRecord | undefined;
  if (!record || !['pending', 'data_committed', 'completed'].includes(record.phase) ||
      !Array.isArray(record.notifications)) throw new TypeError('invalid execution record');
  for (const key of ['requestId', 'tenantId', 'type', 'idempotencyKey', 'payloadHash'] as const) {
    if (record[key] !== raw[key]) throw new TypeError('execution record identity mismatch');
  }
  return structuredClone(record);
}

function assertIdentity(saved: ExecutionRecord, next: ExecutionRecord): void {
  for (const key of ['requestId', 'tenantId', 'type', 'idempotencyKey', 'payloadHash'] as const) {
    if (saved[key] !== next[key]) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, 'execution identity is immutable');
    }
  }
  if (!['pending', 'data_committed', 'completed'].includes(next.phase)) {
    throw new DataSubjectError(DataSubjectErrorCode.InvalidStateTransition);
  }
}

function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'P2002' || error.code === DataSubjectErrorCode.RequestConflict);
}

function isSerializationAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  if (error.code === 'P2034') return true;
  // Prisma reports raw SELECT ... FOR UPDATE serialization aborts as P2010.
  // SQLSTATE 40001 is a known transaction abort; other raw-query failures are not retried.
  if (error.code !== 'P2010' || !('meta' in error) ||
      typeof error.meta !== 'object' || error.meta === null) return false;
  if ('code' in error.meta && error.meta.code === '40001') return true;
  // Prisma 7's pg adapter preserves the server SQLSTATE in the adapter cause.
  if (!('driverAdapterError' in error.meta) ||
      typeof error.meta.driverAdapterError !== 'object' || error.meta.driverAdapterError === null) return false;
  const adapter = error.meta.driverAdapterError;
  return 'cause' in adapter && typeof adapter.cause === 'object' && adapter.cause !== null &&
    'originalCode' in adapter.cause && adapter.cause.originalCode === '40001';
}
