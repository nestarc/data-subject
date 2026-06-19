import type { PolicyEntry } from '../types';

export type DataSubjectLintSeverity = 'warning' | 'error';

export type DataSubjectLintCode =
  | 'dsr_lint_unregistered_model'
  | 'dsr_lint_missing_policy_field'
  | 'dsr_lint_missing_tenant_field'
  | 'dsr_lint_empty_suppression_reason'
  | 'dsr_lint_invalid_policy'
  | 'dsr_lint_subject_field_missing';

export interface DataSubjectLintFinding {
  severity: DataSubjectLintSeverity;
  code: DataSubjectLintCode;
  model: string;
  field?: string;
  message: string;
}

export interface DataSubjectLintRegistryEntry {
  entityName: string;
  subjectField: string;
  tenantField?: string;
  rowLevel?: 'delete-row' | 'delete-fields';
  fields: Record<string, PolicyEntry>;
}

export interface DataSubjectLintSuppression {
  model: string;
  field?: string;
  reason: string;
}

export interface DataSubjectLintConfig {
  registry?: DataSubjectLintRegistryEntry[];
  piiFieldPatterns?: string[];
  suppressions?: DataSubjectLintSuppression[];
  requireTenantField?: boolean;
}

export interface DataSubjectLintReport {
  ok: boolean;
  findings: DataSubjectLintFinding[];
}
