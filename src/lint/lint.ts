import { compilePolicy } from '../policy-compiler';
import { parsePrismaSchema, type PrismaSchemaModel } from './prisma-schema';
import type {
  DataSubjectLintConfig,
  DataSubjectLintFinding,
  DataSubjectLintReport,
  DataSubjectLintSeverity,
} from './types';

const DEFAULT_PII_FIELD_PATTERNS = [
  'email',
  'phone',
  'name',
  'address',
  'ip',
  'birth',
  'birthday',
  'national',
  'ssn',
  'avatar',
];

export function lintPrismaSchema(
  schemaSource: string,
  config: DataSubjectLintConfig = {},
): DataSubjectLintReport {
  const models = parsePrismaSchema(schemaSource);
  const findings: DataSubjectLintFinding[] = [];
  const registry = new Map(
    (config.registry ?? []).map((entry) => [entry.entityName, entry]),
  );
  const suppressions = config.suppressions ?? [];
  const requireTenantField = config.requireTenantField ?? true;

  for (const suppression of suppressions) {
    if (!suppression.reason.trim()) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_empty_suppression_reason',
        model: suppression.model,
        field: suppression.field,
        message: `${formatModelField(
          suppression.model,
          suppression.field,
        )} suppression requires a reason`,
      });
    }
  }

  for (const entry of registry.values()) {
    const model = models.find((item) => item.name === entry.entityName);
    try {
      compilePolicy({
        entityName: entry.entityName,
        subjectField: entry.subjectField,
        rowLevel: entry.rowLevel,
        fields: entry.fields,
      });
    } catch (error) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_invalid_policy',
        model: entry.entityName,
        message:
          error instanceof Error
            ? error.message
            : `${entry.entityName} has an invalid data subject policy`,
      });
    }

    if (!model) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_unregistered_model',
        model: entry.entityName,
        message: `${entry.entityName} is registered but is not present in the Prisma schema`,
      });
      continue;
    }

    if (!hasField(model, entry.subjectField)) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_subject_field_missing',
        model: entry.entityName,
        field: entry.subjectField,
        message: `${entry.entityName}.${entry.subjectField} subjectField is missing from the Prisma schema`,
      });
    }

    if (requireTenantField && !entry.tenantField) {
      findings.push({
        severity: 'warning',
        code: 'dsr_lint_missing_tenant_field',
        model: entry.entityName,
        message: `${entry.entityName} has no tenantField in the data-subject lint config`,
      });
    }

    for (const field of Object.keys(entry.fields)) {
      if (!hasField(model, field)) {
        findings.push({
          severity: 'error',
          code: 'dsr_lint_missing_policy_field',
          model: entry.entityName,
          field,
          message: `${entry.entityName}.${field} is in the data subject policy but not in the Prisma schema`,
        });
      }
    }
  }

  const patterns = config.piiFieldPatterns ?? DEFAULT_PII_FIELD_PATTERNS;
  for (const model of models) {
    const candidates = model.fields.filter((field) =>
      isPiiCandidate(field.name, patterns),
    );
    if (candidates.length === 0 || isSuppressed(suppressions, model.name)) {
      continue;
    }

    const entry = registry.get(model.name);
    if (!entry) {
      findings.push({
        severity: 'error',
        code: 'dsr_lint_unregistered_model',
        model: model.name,
        field: candidates[0]?.name,
        message: `${model.name} has PII-like fields but is not registered or suppressed`,
      });
      continue;
    }

    for (const field of candidates) {
      if (isSuppressed(suppressions, model.name, field.name)) {
        continue;
      }

      if (!(field.name in entry.fields)) {
        findings.push({
          severity: 'error',
          code: 'dsr_lint_missing_policy_field',
          model: model.name,
          field: field.name,
          message: `${model.name}.${field.name} looks like PII but is missing from the data subject policy`,
        });
      }
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'error'),
    findings,
  };
}

export function formatLintReport(report: DataSubjectLintReport): string {
  if (report.findings.length === 0) {
    return 'data-subject lint: ok';
  }

  return report.findings
    .map(
      (finding) =>
        `[${finding.severity}] ${finding.code} ${formatModelField(
          finding.model,
          finding.field,
        )}: ${finding.message}`,
    )
    .join('\n');
}

export function shouldFailLint(
  report: DataSubjectLintReport,
  failOn: DataSubjectLintSeverity,
): boolean {
  if (failOn === 'warning') {
    return report.findings.length > 0;
  }
  return report.findings.some((finding) => finding.severity === 'error');
}

function hasField(model: PrismaSchemaModel, fieldName: string): boolean {
  return model.fields.some((field) => field.name === fieldName);
}

function isPiiCandidate(fieldName: string, patterns: string[]): boolean {
  const normalized = fieldName.toLowerCase().replace(/[_-]/g, '');
  return patterns.some((pattern) =>
    normalized.includes(pattern.toLowerCase().replace(/[_-]/g, '')),
  );
}

function isSuppressed(
  suppressions: NonNullable<DataSubjectLintConfig['suppressions']>,
  model: string,
  field?: string,
): boolean {
  return suppressions.some(
    (suppression) =>
      suppression.model === model &&
      suppression.reason.trim().length > 0 &&
      (field ? suppression.field === field || !suppression.field : true),
  );
}

function formatModelField(model: string, field?: string): string {
  return field ? `${model}.${field}` : model;
}
