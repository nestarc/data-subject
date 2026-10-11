import type { PolicySpec } from '../policy-compiler';
import type { EntityDefinition } from '../policy-definition';

export type DataSubjectLintSeverity = 'warning' | 'error';

export type DataSubjectLintCode =
  | 'dsr_lint_unregistered_model'
  | 'dsr_lint_missing_policy_field'
  | 'dsr_lint_missing_tenant_field'
  | 'dsr_lint_empty_suppression_reason'
  | 'dsr_lint_invalid_policy'
  | 'dsr_lint_subject_field_missing'
  | 'dsr_lint_schema_unsupported'
  | 'dsr_lint_nonnullable_write'
  | 'dsr_lint_unmapped_relation'
  | 'dsr_lint_relation_conflict'
  | 'dsr_lint_retention_conflict'
  | 'dsr_lint_dependency_order'
  | 'dsr_lint_dependency_cycle';

export interface DataSubjectLintFinding {
  severity: DataSubjectLintSeverity;
  code: DataSubjectLintCode;
  model: string;
  field?: string;
  message: string;
}

export interface DataSubjectLintRegistryEntry extends PolicySpec {
  tenantField?: string;
  singleTenantId?: string;
  ignoredFields?: Record<string, string>;
  relations?: string[];
}

export interface DataSubjectLintSuppression {
  model: string;
  field?: string;
  reason: string;
}

export interface DataSubjectLintConfig {
  /** The same JSON-compatible definitions passed to Registry.registerDefinition. */
  definitions?: EntityDefinition[];
  /** Legacy configuration. Prefer definitions for a shared runtime/lint source. */
  registry?: DataSubjectLintRegistryEntry[];
  piiFieldPatterns?: string[];
  suppressions?: DataSubjectLintSuppression[];
  requireTenantField?: boolean;
  /** Check every scalar, including newly added fields without PII-like names. Defaults true with definitions. */
  strictCoverage?: boolean;
  /** Validate declared relations and child-before-parent dependencies. Defaults true with definitions. */
  checkRelations?: boolean;
}

export interface DataSubjectLintReport {
  ok: boolean;
  findings: DataSubjectLintFinding[];
}
