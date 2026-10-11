/** Queue payloads and checkpoints must be plain JSON; never put credentials in them. */
export type JobJson = null | boolean | number | string | JobJson[] | { [key: string]: JobJson };

export interface JobSubmitInput {
  id: string;
  tenantId: string;
  kind: string;
  idempotencyKey: string;
  payload: JobJson;
}

export interface JobRecord extends JobSubmitInput {
  readonly payloadHash: string;
  state: 'queued' | 'completed' | 'failed' | 'cancelled';
  checkpoint: JobJson;
  result: JobJson;
  processedRows: number;
  pagesCommitted: number;
  chunksWritten: number;
  /** Consecutive failed steps. A successfully committed page resets this count. */
  attempts: number;
  revision: number;
  hasCommittedChanges: boolean;
  /** Failed/cancelled with committed changes, or possible external changes requiring reconciliation. */
  partial: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  availableAt: Date;
  completedAt: Date | null;
  chunksDeletedAt: Date | null;
  /** Immutable payload/chunk retention deadline, measured by the database clock. */
  expiresAt: Date;
  purgedAt: Date | null;
}

export interface JobStepResult {
  done: boolean;
  checkpoint: JobJson;
  /** Number of scope rows processed by this page, not a cumulative total. */
  processedRows: number;
  /** Set for business mutations, or before external work whose commit may be uncertain. Retain/export alone do not count. */
  hasCommittedChanges?: boolean;
  result?: JobJson;
}

export interface JobTransaction {
  /** Snapshot of the locked job. Mutating this object does not persist anything. */
  readonly job: JobRecord;
  /** At most one bounded immutable chunk per page, committed with the checkpoint. */
  appendChunk(body: Buffer): Promise<void>;
}

export type JobHandler = (transaction: JobTransaction) => Promise<JobStepResult>;
export interface JobFilter { kind?: string; tenantId?: string }

export interface DurableJobStore {
  submit(input: JobSubmitInput): Promise<{ job: JobRecord; created: boolean }>;
  get(id: string, tenantId: string): Promise<JobRecord | null>;
  cancel(id: string, tenantId: string): Promise<JobRecord>;
  /** Explicitly resume the committed checkpoint of a failed/cancelled job. */
  retry(id: string, tenantId: string): Promise<JobRecord>;
  /** One bounded transaction, never an unbounded loop or arbitrary external I/O. */
  runNext(handler: JobHandler, filter?: JobFilter): Promise<JobRecord | null>;
  readChunks(id: string, tenantId: string): AsyncIterable<{ index: number; body: Buffer }>;
  deleteChunks(id: string, tenantId: string): Promise<void>;
  /** Processes at most limit jobs and 1000 chunks per job; repeat until it returns zero. */
  purgeExpiredChunks(limit?: number): Promise<number>;
}
