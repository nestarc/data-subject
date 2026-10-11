import type { DataSubjectRequest, RequestStats, RequestType } from '../types';
import type { RequestStorage } from './request-storage.interface';

/** Bytes are cleared atomically with request completion after upload succeeds. */
export interface DurableArtifact {
  key: string;
  contentType: string;
  bodyBase64: string | null;
  hash: string;
  url?: string;
  expiresAt?: string;
  discardedAt?: string;
}

/** Delivery is at least once. Consumers must deduplicate by this stable id. */
export interface ExecutionNotification {
  id: string;
  channel: 'outbox' | 'audit';
  event: string;
  payload: Record<string, unknown>;
  delivered: boolean;
  lastError?: string;
}

export interface ExecutionRecord {
  readonly requestId: string;
  readonly tenantId: string;
  readonly type: RequestType;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  phase: 'pending' | 'data_committed' | 'completed';
  artifact: DurableArtifact | null;
  stats: RequestStats | null;
  notifications: ExecutionNotification[];
}

export interface ExecutionTransaction {
  record: ExecutionRecord;
  /** Uses the same database transaction as the locked execution and bound executors. */
  requests: RequestStorage;
  save(record: ExecutionRecord): Promise<void>;
}

/** One database only: host executors must use the transaction supplied by the store. */
export interface DurableExecutionStore {
  readonly requests: RequestStorage;
  /** Administrative metadata scan. Recheck expiry under withLock before clearing bytes. */
  listExpiredArtifacts(now: Date, limit: number): Promise<Array<{ requestId: string; tenantId: string }>>;
  reserve(
    request: DataSubjectRequest,
    idempotencyKey: string,
    payloadHash: string,
  ): Promise<{ request: DataSubjectRequest; created: boolean }>;
  withLock<T>(
    requestId: string,
    tenantId: string,
    work: (transaction: ExecutionTransaction) => Promise<T>,
  ): Promise<T>;
}
