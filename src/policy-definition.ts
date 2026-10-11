import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { compilePolicy, type PolicySpec } from './policy-compiler';
import type { TenantScope } from './types';

/** One JSON-compatible policy source shared by registration and schema lint. */
export interface EntityDefinition extends PolicySpec {
  scope: TenantScope;
  /** Every deliberate scalar-field exclusion has an auditable explanation. */
  ignoredFields?: Record<string, string>;
  /** Explicit Prisma relation field names reviewed by schema lint. */
  relations?: string[];
}

export function definePolicy(definitions: readonly EntityDefinition[]): EntityDefinition[] {
  if (!Array.isArray(definitions)) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      'Policy definitions must be an array',
    );
  }
  assertJson(definitions);
  const names = new Set<string>();
  return definitions.map((definition) => {
    validateDefinition(definition);
    if (names.has(definition.entityName)) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `Duplicate definition ${definition.entityName}`,
      );
    }
    names.add(definition.entityName);
    return JSON.parse(JSON.stringify(definition)) as EntityDefinition;
  });
}

export function validateDefinition(definition: EntityDefinition): void {
  assertJson(definition);
  compilePolicy(definition);
  const { scope } = definition;
  if (
    !scope ||
    (scope.mode !== 'multi-tenant' && scope.mode !== 'single-tenant') ||
    (scope.mode === 'multi-tenant' &&
      (!validName(scope.tenantField) || scope.tenantField === definition.subjectField)) ||
    (scope.mode === 'single-tenant' &&
      (typeof scope.tenantId !== 'string' || !scope.tenantId.trim()))
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${definition.entityName}: invalid policy scope`,
    );
  }
  if (
    definition.ignoredFields !== undefined &&
    (!definition.ignoredFields ||
      typeof definition.ignoredFields !== 'object' ||
      Array.isArray(definition.ignoredFields))
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${definition.entityName}: ignoredFields must map field names to reasons`,
    );
  }
  for (const [field, reason] of Object.entries(definition.ignoredFields ?? {})) {
    if (
      !validName(field) ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      Object.hasOwn(definition.fields, field)
    ) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${definition.entityName}.${field}: excluded fields require a nonblank reason and cannot also have a policy`,
      );
    }
  }
  if (
    definition.relations !== undefined &&
    (!Array.isArray(definition.relations) ||
      definition.relations.some((field) => !validName(field)) ||
      new Set(definition.relations).size !== definition.relations.length)
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${definition.entityName}: relations must be unique field names`,
    );
  }
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function assertJson(value: unknown, ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (typeof value !== 'object' || ancestors.has(value)) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      'Policy definitions must contain only JSON values without cycles',
    );
  }
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (!Array.isArray(value) && prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      'Policy definitions must contain only plain JSON objects',
    );
  }
  if (
    Object.getOwnPropertySymbols(value).length > 0 ||
    (Array.isArray(value) && Object.keys(value).length !== value.length)
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      'Policy definitions cannot contain symbol keys or sparse arrays',
    );
  }
  ancestors.add(value);
  for (const child of Object.values(value)) assertJson(child, ancestors);
  ancestors.delete(value);
}
