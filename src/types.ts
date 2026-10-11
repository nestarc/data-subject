export type Strategy = 'delete' | 'anonymize' | 'retain';
export type RequestEntityStrategy = Strategy | 'mixed' | 'export';
export type RowLevel = 'delete-row' | 'delete-fields';

export type PolicyEntry =
  | 'delete'
  | { strategy: 'delete' }
  | { strategy: 'anonymize'; replacement: string | number | null }
  | {
      strategy: 'retain';
      legalBasis: string;
      until?: string;
      pseudonymize?: 'hmac' | 'none';
    };

export interface EntityPolicy {
  entityName: string;
  subjectField: string;
  rowLevel: RowLevel;
  fields: Record<string, PolicyEntry>;
  exportFields: string[];
  stableIdField?: string;
  dependsOn?: string[];
}

export interface ErasePlan {
  rowLevel: RowLevel;
  deleteFields: string[];
}

export type TenantScope =
  | { mode: 'multi-tenant'; tenantField: string }
  | { mode: 'single-tenant'; tenantId: string };

export interface EntityExecutor {
  /** Required at runtime by DataSubjectService; custom executors must enforce this scope. */
  scope?: TenantScope;
  identityField?: string;
  selectByIds?(ids: unknown[], tenantId: string): Promise<Record<string, unknown>[]>;
  select(subjectId: string, tenantId: string): Promise<Record<string, unknown>[]>;
  erase(subjectId: string, tenantId: string, plan: ErasePlan): Promise<number>;
  anonymize(
    subjectId: string,
    tenantId: string,
    replacements: Record<string, unknown>,
  ): Promise<number>;
}

export interface RegisteredEntity {
  policy: EntityPolicy;
  executor: EntityExecutor;
}

export type RequestType = 'export' | 'erase';
export type RequestState = 'created' | 'validating' | 'processing' | 'completed' | 'failed';

export interface DataSubjectRequest {
  id: string;
  tenantId: string;
  subjectId: string;
  type: RequestType;
  state: RequestState;
  createdAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  artifactHash: string | null;
  artifactUrl: string | null;
  stats: RequestStats | null;
  requestedBy: string | null;
}

export interface RequestStats {
  policyHash?: string;
  verification?: Array<{ entityName: string } & EntityVerification>;
  /** Stored in the existing stats JSON column; no schema migration is required. */
  lifecycle?: RequestLifecycle;
  entities: Array<{
    entityName: string;
    affected: number;
    strategy: RequestEntityStrategy;
  }>;
  retained?: Array<{
    entityName: string;
    field: string;
    legalBasis: string;
    until?: string;
    count: number;
  }>;
  verificationResidual?: Array<{ entityName: string; count: number }>;
  preScan?: Array<{ entityName: string; count: number }>;
  postScan?: Array<{ entityName: string; count: number }>;
  evidence?: {
    schemaVersion: 'data-subject.evidence.v1' | 'data-subject.evidence.v2';
    artifactHash: string;
    artifactUrl: string;
  };
}

export type FailureStage =
  | 'request_created'
  | 'processing'
  | 'data_execution'
  | 'artifact_write'
  | 'completion_persistence';

export interface RequestLifecycle {
  artifactFailure?: { code: string; recovery: 'retry_artifact' | 'artifact_expired' };
  dataOutcome: 'not_started' | 'unknown' | 'completed';
  failureStage?: FailureStage;
  recovery?:
    | 'retry_request'
    | 'inspect_data'
    | 'retry_artifact'
    | 'reconcile_request'
    | 'artifact_expired';
  /** Callback delivery failures never undo completed data processing. */
  notificationFailures?: Array<{
    channel: 'outbox' | 'audit';
    event: string;
    code: string;
    recovery: 'retry_notification';
  }>;
}

export interface ErasureEvidenceAction {
  entityName: string;
  strategy: Exclude<RequestEntityStrategy, 'export'>;
  affected: number;
  rowLevel: RowLevel;
  effectiveRowStrategy?: 'delete-row' | 'update-fields' | 'retain';
  verification?: EntityVerification;
  deleteFields?: string[];
  anonymizedFields?: string[];
  retainedFields?: Array<{
    field: string;
    legalBasis: string;
    until?: string;
    count: number;
  }>;
}

export interface ErasureEvidenceArtifact {
  schemaVersion: 'data-subject.erasure-evidence.v1' | 'data-subject.erasure-evidence.v2';
  policyHash?: string;
  verificationOverall?: 'verified' | 'unverified' | 'failed';
  failureStage?: FailureStage;
  requestId: string;
  tenantId: string;
  requestType: 'erase';
  generatedAt: string;
  state: 'completed' | 'failed';
  preScan: Array<{ entityName: string; count: number }>;
  actions: ErasureEvidenceAction[];
  postScan: Array<{ entityName: string; count: number }>;
  verificationResidual: Array<{ entityName: string; count: number }>;
  artifactHashAlgorithm: 'sha256';
}

export interface EntityVerification {
  status: 'verified' | 'unverified' | 'failed';
  checkedRows: number;
  fields: Array<{
    field: string;
    strategy: Strategy;
    checked: number;
    status: 'verified' | 'unverified' | 'failed';
  }>;
}

export type DataSubjectOutboxEvent =
  | {
      type: 'data_subject.artifact_expired';
      payload: { requestId: string; tenantId: string; requestType: RequestType };
    }
  | {
      type: 'data_subject.request_created';
      payload: {
        requestId: string;
        requestType: RequestType;
        tenantId: string;
        subjectId: string;
      };
    }
  | {
      type: 'data_subject.erasure_requested';
      payload: {
        requestId: string;
        tenantId: string;
        subjectId: string;
        requestedAt: string;
      };
    }
  | {
      type: 'data_subject.request_completed';
      payload: {
        requestId: string;
        requestType: RequestType;
        tenantId: string;
        artifactHash: string;
        state: 'completed';
      };
    }
  | {
      type: 'data_subject.request_failed';
      payload: {
        requestId: string;
        requestType: RequestType;
        tenantId: string;
        failureReason: string;
        failureStage: FailureStage;
        dataOutcome: RequestLifecycle['dataOutcome'];
        recovery: NonNullable<RequestLifecycle['recovery']>;
      };
    };
