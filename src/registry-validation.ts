import type { Registry } from './registry';
import type { DataSubjectLintFinding } from './lint/types';
import { lintPrismaSchema } from './lint/lint';
import type { RegisteredEntity } from './types';

export interface RegistryValidationOptions {
  requireTenantField?: boolean;
  /** Schema validation requires every entity to use registerDefinition. */
  schemaSource?: string;
  strictCoverage?: boolean;
}

export interface RegistryValidationReport {
  ok: boolean;
  findings: DataSubjectLintFinding[];
}

export function validateRegistry(
  registry: Registry,
  opts: RegistryValidationOptions = {},
): RegistryValidationReport {
  const findings: DataSubjectLintFinding[] = [];
  let entries: RegisteredEntity[];
  try {
    entries = registry.list();
  } catch (error) {
    return {
      ok: false,
      findings: [
        {
          severity: 'error',
          code: 'dsr_lint_dependency_order',
          model: '<registry>',
          message: error instanceof Error ? error.message : 'Invalid entity dependency order',
        },
      ],
    };
  }

  for (const entry of entries) {
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

  if (opts.schemaSource !== undefined) {
    const definitions = registry.definitions();
    for (const entry of entries) {
      if (!definitions.some((definition) => definition.entityName === entry.policy.entityName)) {
        findings.push({
          severity: 'error',
          code: 'dsr_lint_invalid_policy',
          model: entry.policy.entityName,
          message:
            'Schema validation requires registerDefinition to share the runtime and lint policy',
        });
      }
    }
    findings.push(
      ...lintPrismaSchema(opts.schemaSource, {
        definitions,
        strictCoverage: opts.strictCoverage ?? true,
        requireTenantField: opts.requireTenantField,
      }).findings,
    );
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
  };
}
