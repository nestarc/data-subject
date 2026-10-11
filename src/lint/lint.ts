import { compilePolicy } from '../policy-compiler';
import { definePolicy } from '../policy-definition';
import { parsePrismaSchema, type PrismaSchemaModel } from './prisma-schema';
import type {
  DataSubjectLintConfig,
  DataSubjectLintFinding,
  DataSubjectLintRegistryEntry,
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
  const findings: DataSubjectLintFinding[] = [];
  const add = (
    code: DataSubjectLintFinding['code'],
    model: string,
    message: string,
    field?: string,
    severity: DataSubjectLintSeverity = 'error',
  ): void => {
    findings.push({ severity, code, model, ...(field ? { field } : {}), message });
  };
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    (config.registry !== undefined &&
      (!Array.isArray(config.registry) ||
        config.registry.some((entry) => !entry || typeof entry !== 'object'))) ||
    (config.piiFieldPatterns !== undefined &&
      (!Array.isArray(config.piiFieldPatterns) ||
        config.piiFieldPatterns.some((pattern) => typeof pattern !== 'string'))) ||
    (config.suppressions !== undefined &&
      (!Array.isArray(config.suppressions) ||
        config.suppressions.some(
          (item) => !item || typeof item !== 'object' || typeof item.model !== 'string',
        )))
  ) {
    add('dsr_lint_invalid_policy', '<config>', 'Invalid lint configuration structure');
    return { ok: false, findings };
  }
  let models: PrismaSchemaModel[];
  try {
    models = parsePrismaSchema(schemaSource);
  } catch (error) {
    add(
      'dsr_lint_schema_unsupported',
      '<schema>',
      error instanceof Error ? error.message : 'Unsupported Prisma schema',
    );
    return { ok: false, findings };
  }
  let entries: DataSubjectLintRegistryEntry[] = config.registry ?? [];
  if (config.definitions) {
    if (config.registry)
      add('dsr_lint_invalid_policy', '<config>', 'Use definitions or registry, not both');
    try {
      entries = definePolicy(config.definitions).map((definition) => ({
        ...definition,
        ...(definition.scope.mode === 'multi-tenant'
          ? { tenantField: definition.scope.tenantField }
          : { singleTenantId: definition.scope.tenantId }),
      }));
    } catch (error) {
      add(
        'dsr_lint_invalid_policy',
        '<config>',
        error instanceof Error ? error.message : 'Invalid shared definitions',
      );
      return { ok: false, findings };
    }
  }
  const registry = new Map<string, DataSubjectLintRegistryEntry>();
  for (const entry of entries) {
    if (registry.has(entry.entityName))
      add('dsr_lint_invalid_policy', entry.entityName, 'Duplicate entity definition');
    registry.set(entry.entityName, entry);
  }
  const strict = config.strictCoverage ?? !!config.definitions;
  const checkRelations = config.checkRelations ?? !!config.definitions;
  const suppressions = config.suppressions ?? [];
  for (const suppression of suppressions) {
    if (typeof suppression.reason !== 'string' || !suppression.reason.trim()) {
      add(
        'dsr_lint_empty_suppression_reason',
        suppression.model,
        'Suppression requires a nonblank reason',
        suppression.field,
      );
    }
  }
  for (const entry of registry.values()) {
    const model = models.find((item) => item.name === entry.entityName);
    try {
      compilePolicy(entry);
    } catch (error) {
      add(
        'dsr_lint_invalid_policy',
        entry.entityName,
        error instanceof Error ? error.message : 'Invalid data subject policy',
      );
      registry.delete(entry.entityName);
      continue;
    }
    if (!model) {
      add(
        'dsr_lint_unregistered_model',
        entry.entityName,
        'Registered model is absent from Prisma schema',
      );
      continue;
    }
    const fieldFor = (name: string) =>
      model.fields.find((field) => field.name === name && field.kind === 'scalar');
    if (!fieldFor(entry.subjectField))
      add(
        'dsr_lint_subject_field_missing',
        model.name,
        'subjectField must name a scalar schema field',
        entry.subjectField,
      );
    if ((config.requireTenantField ?? true) && !entry.tenantField && !entry.singleTenantId) {
      add(
        'dsr_lint_missing_tenant_field',
        model.name,
        'Declare tenantField or an explicit single-tenant scope',
        undefined,
        strict ? 'error' : 'warning',
      );
    }
    if (
      entry.tenantField &&
      (!fieldFor(entry.tenantField) || entry.tenantField === entry.subjectField)
    ) {
      add(
        'dsr_lint_missing_tenant_field',
        model.name,
        'tenantField must name a distinct scalar schema field',
        entry.tenantField,
      );
    }
    if (entry.stableIdField && !fieldFor(entry.stableIdField))
      add(
        'dsr_lint_invalid_policy',
        model.name,
        'stableIdField must name a scalar schema field',
        entry.stableIdField,
      );
    for (const [name, policy] of Object.entries(entry.fields)) {
      const field = fieldFor(name);
      if (!field) {
        add(
          'dsr_lint_missing_policy_field',
          model.name,
          'Policy field is absent or is a relation, not a scalar',
          name,
        );
        continue;
      }
      const writesNull =
        policy === 'delete' ||
        policy.strategy === 'delete' ||
        (policy.strategy === 'anonymize' && policy.replacement === null);
      if (!deletesRow(entry) && writesNull && (!field.optional || field.list)) {
        add(
          'dsr_lint_nonnullable_write',
          model.name,
          'Field deletion/null replacement requires a nullable scalar; use row deletion or a valid static replacement',
          name,
        );
      }
    }
    for (const name of entry.exportFields ?? [])
      if (!fieldFor(name))
        add(
          'dsr_lint_missing_policy_field',
          model.name,
          'Export allowlist field is absent or a relation',
          name,
        );
    for (const [name, reason] of Object.entries(entry.ignoredFields ?? {})) {
      if (typeof reason !== 'string' || !reason.trim())
        add(
          'dsr_lint_empty_suppression_reason',
          model.name,
          'ignoredFields requires a nonblank reason',
          name,
        );
      if (!fieldFor(name) || Object.hasOwn(entry.fields, name))
        add(
          'dsr_lint_invalid_policy',
          model.name,
          'Ignored field must exist and cannot also have a policy',
          name,
        );
    }
    for (const relation of entry.relations ?? [])
      if (!model.fields.some((field) => field.name === relation && field.kind === 'relation')) {
        add(
          'dsr_lint_unmapped_relation',
          model.name,
          'Declared relation is absent from Prisma schema',
          relation,
        );
      }
  }
  for (const model of models) {
    if (isSuppressed(suppressions, model.name)) continue;
    const entry = registry.get(model.name);
    const candidates = model.fields.filter(
      (field) =>
        field.kind === 'scalar' &&
        (strict ||
          isPiiCandidate(field.name, config.piiFieldPatterns ?? DEFAULT_PII_FIELD_PATTERNS)),
    );
    if (!entry && candidates.length) {
      add(
        'dsr_lint_unregistered_model',
        model.name,
        strict
          ? 'Model must be registered or explicitly excluded with a reason'
          : 'Model has PII-like fields but no policy',
      );
      continue;
    }
    if (!entry) continue;
    for (const field of candidates) {
      if (isSuppressed(suppressions, model.name, field.name)) continue;
      if (
        strict &&
        (field.name === entry.subjectField ||
          field.name === entry.tenantField ||
          field.name === entry.stableIdField)
      )
        continue;
      if (
        !Object.hasOwn(entry.fields, field.name) &&
        !hasReason(entry.ignoredFields?.[field.name])
      ) {
        add(
          'dsr_lint_missing_policy_field',
          model.name,
          strict
            ? 'Every scalar field requires a policy or a reasoned exclusion'
            : 'PII-like field is missing a policy',
          field.name,
        );
      }
    }
  }
  validateDependencies(registry, add);
  if (checkRelations) validateRelations(models, registry, add);
  return { ok: !findings.some((finding) => finding.severity === 'error'), findings };
}

type AddFinding = (
  code: DataSubjectLintFinding['code'],
  model: string,
  message: string,
  field?: string,
  severity?: DataSubjectLintSeverity,
) => void;

function validateDependencies(
  registry: Map<string, DataSubjectLintRegistryEntry>,
  add: AddFinding,
): void {
  const graph = new Map<string, string[]>();
  for (const entry of registry.values()) {
    graph.set(entry.entityName, entry.dependsOn ?? []);
    for (const parent of entry.dependsOn ?? [])
      if (!registry.has(parent))
        add('dsr_lint_dependency_order', entry.entityName, `Missing dependency ${parent}`);
  }
  for (const name of cyclicNodes(graph))
    add('dsr_lint_dependency_cycle', name, 'Cyclic entity dependencies are unsupported');
}

function validateRelations(
  models: PrismaSchemaModel[],
  registry: Map<string, DataSubjectLintRegistryEntry>,
  add: AddFinding,
): void {
  const graph = new Map<string, string[]>();
  for (const model of models) {
    const child = registry.get(model.name);
    for (const field of model.fields.filter((item) => item.kind === 'relation')) {
      const relation = field.relation!;
      const parent = registry.get(relation.target);
      if (!child && !parent) continue;
      if (!child || !parent || !child.relations?.includes(field.name)) {
        add(
          'dsr_lint_unmapped_relation',
          model.name,
          `Relation to ${relation.target} requires both registered entities and an explicit relation declaration`,
          field.name,
        );
      }
      const targetModel = models.find((item) => item.name === relation.target)!;
      if (relation.fields.length === 0) {
        const owner = targetModel.fields.find(
          (other) =>
            other.kind === 'relation' &&
            other.relation?.target === model.name &&
            other.relation.fields.length > 0 &&
            other.relation.name === relation.name,
        );
        if (!owner)
          add(
            'dsr_lint_relation_conflict',
            model.name,
            'Implicit many-to-many or unpaired relations are unsupported; use an explicit join model',
            field.name,
          );
        continue;
      }
      graph.set(model.name, [...(graph.get(model.name) ?? []), relation.target]);
      if (
        relation.fields.length !== relation.references.length ||
        relation.fields.some(
          (name) => !model.fields.some((item) => item.name === name && item.kind === 'scalar'),
        ) ||
        relation.references.some(
          (name) =>
            !targetModel.fields.some((item) => item.name === name && item.kind === 'scalar'),
        )
      ) {
        add(
          'dsr_lint_relation_conflict',
          model.name,
          'Relation fields/references must name matching scalar columns',
          field.name,
        );
      }
      if (!child || !parent || !deletesRow(parent)) continue;
      const detaches =
        relation.fields.length > 0 &&
        relation.fields.every((name) => {
          const scalar = model.fields.find((item) => item.name === name);
          const policy = child.fields[name];
          return (
            scalar?.optional &&
            policy &&
            (policy === 'delete' ||
              policy.strategy === 'delete' ||
              (policy.strategy === 'anonymize' && policy.replacement === null))
          );
        });
      if (!child.dependsOn?.includes(parent.entityName))
        add(
          'dsr_lint_dependency_order',
          child.entityName,
          `Declare dependsOn: ["${parent.entityName}"] so child writes precede parent deletion`,
          field.name,
        );
      if (!deletesRow(child) && !detaches) {
        const retains = Object.values(child.fields).some(
          (policy) => policy !== 'delete' && policy.strategy === 'retain',
        );
        add(
          retains ? 'dsr_lint_retention_conflict' : 'dsr_lint_relation_conflict',
          model.name,
          `Parent row deletion (${relation.onDelete ?? 'Prisma default'}) conflicts with child rows that are neither deleted nor detached`,
          field.name,
        );
      }
    }
  }
  for (const name of cyclicNodes(graph))
    add('dsr_lint_dependency_cycle', name, 'Cyclic schema relations are unsupported');
}

function cyclicNodes(graph: Map<string, string[]>): Set<string> {
  const done = new Set<string>();
  const active: string[] = [];
  const cycles = new Set<string>();
  const visit = (name: string): void => {
    const index = active.indexOf(name);
    if (index !== -1) {
      active.slice(index).forEach((item) => cycles.add(item));
      return;
    }
    if (done.has(name)) return;
    active.push(name);
    for (const next of graph.get(name) ?? []) visit(next);
    active.pop();
    done.add(name);
  };
  for (const name of graph.keys()) visit(name);
  return cycles;
}

function deletesRow(entry: DataSubjectLintRegistryEntry): boolean {
  return (
    entry.rowLevel === 'delete-row' &&
    Object.keys(entry.fields).length > 0 &&
    Object.values(entry.fields).every(
      (policy) => policy === 'delete' || policy.strategy === 'delete',
    )
  );
}
function hasReason(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
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
      hasReason(suppression.reason) &&
      (field ? suppression.field === field || !suppression.field : !suppression.field),
  );
}
function formatModelField(model: string, field?: string): string {
  return field ? `${model}.${field}` : model;
}
export function formatLintReport(report: DataSubjectLintReport): string {
  if (!report.findings.length) return 'data-subject lint: ok';
  return report.findings
    .map(
      (finding) =>
        `[${finding.severity}] ${finding.code} ${formatModelField(finding.model, finding.field)}: ${finding.message}`,
    )
    .join('\n');
}
export function shouldFailLint(
  report: DataSubjectLintReport,
  failOn: DataSubjectLintSeverity,
): boolean {
  return failOn === 'warning'
    ? report.findings.length > 0
    : report.findings.some((finding) => finding.severity === 'error');
}
