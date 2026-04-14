export type Strategy = 'delete' | 'anonymize' | 'retain';

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
  rowLevel?: 'delete-row' | 'delete-fields';
  fields: Record<string, PolicyEntry>;
}

export interface EntityExecutor {
  select(subjectId: string, tenantId: string): Promise<Record<string, unknown>[]>;
  erase(subjectId: string, tenantId: string, rowLevel: 'delete-row' | 'delete-fields'): Promise<number>;
  anonymize(subjectId: string, tenantId: string, replacements: Record<string, unknown>): Promise<number>;
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
  entities: Array<{
    entityName: string;
    affected: number;
    strategy: Strategy | 'mixed';
  }>;
  retained?: Array<{ entityName: string; field: string; legalBasis: string; count: number }>;
  verificationResidual?: Array<{ entityName: string; count: number }>;
}
