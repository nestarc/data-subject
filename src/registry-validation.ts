import type { Registry } from './registry';
import type { DataSubjectLintFinding } from './lint/types';

export interface RegistryValidationReport {
  ok: boolean;
  findings: DataSubjectLintFinding[];
}

export function validateRegistry(
  registry: Registry,
  opts: { requireTenantField?: boolean } = {},
): RegistryValidationReport {
  const findings: DataSubjectLintFinding[] = [];

  for (const entry of registry.list()) {
    const { policy } = entry;

    if (!policy.subjectField.trim()) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_subject_field_missing',
        model: policy.entityName,
        message: `${policy.entityName} has an empty subjectField`,
      });
    }

    if (Object.keys(policy.fields).length === 0) {
      findings.push({
        severity: 'warning',
        code: 'dsr_lint_missing_policy_field',
        model: policy.entityName,
        message: `${policy.entityName} has no data subject policy fields`,
      });
    }

    if (
      opts.requireTenantField &&
      (entry.executor.scope?.mode !== 'multi-tenant' ||
        !entry.executor.scope.tenantField?.trim() ||
        entry.executor.scope.tenantField === policy.subjectField)
    ) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_missing_tenant_field',
        model: policy.entityName,
        message: `${policy.entityName} requires multi-tenant executor metadata with a distinct, nonblank tenantField`,
      });
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
  };
}
