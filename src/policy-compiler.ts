import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { validateLegalBasis } from './legal-basis';
import type { EntityPolicy, PolicyEntry } from './types';

export interface CompileOptions {
  strictLegalBasis?: boolean;
}

export interface PolicySpec {
  entityName: string;
  subjectField: string;
  rowLevel?: 'delete-row' | 'delete-fields';
  fields: Record<string, PolicyEntry>;
  /** Explicit top-level export allowlist. Omit for an erase-only entity. */
  exportFields?: string[];
  /** Immutable row identity used for post-write verification. */
  stableIdField?: string;
  /** Parent entities: this entity is erased before each named parent. */
  dependsOn?: string[];
}

export function compilePolicy(spec: PolicySpec, opts: CompileOptions = {}): EntityPolicy {
  if (
    !spec ||
    !isName(spec.entityName) ||
    !isName(spec.subjectField) ||
    !spec.fields ||
    typeof spec.fields !== 'object' ||
    Array.isArray(spec.fields) ||
    (spec.rowLevel !== undefined &&
      spec.rowLevel !== 'delete-row' &&
      spec.rowLevel !== 'delete-fields')
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      'Policy requires valid entityName, subjectField, rowLevel and fields',
    );
  }
  const fields: Record<string, PolicyEntry> = {};
  const exportFields = spec.exportFields ?? [];
  const dependsOn = spec.dependsOn ?? [];

  if (
    (spec.stableIdField !== undefined && !isName(spec.stableIdField)) ||
    !Array.isArray(dependsOn) ||
    dependsOn.some((name) => !isName(name) || name === spec.entityName) ||
    new Set(dependsOn).size !== dependsOn.length
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${spec.entityName}: invalid stableIdField or dependsOn`,
    );
  }

  if (
    !Array.isArray(exportFields) ||
    exportFields.some(
      (field) => typeof field !== 'string' || !field.trim() || field !== field.trim(),
    ) ||
    new Set(exportFields).size !== exportFields.length
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${spec.entityName}: exportFields must contain unique, nonblank top-level field names`,
    );
  }

  for (const [name, raw] of Object.entries(spec.fields)) {
    if (!isName(name)) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${spec.entityName}: invalid policy field name`,
      );
    }
    Object.defineProperty(fields, name, {
      value: normalizeEntry(spec.entityName, name, raw, opts),
      enumerable: true,
    });
  }

  const deletesRow =
    spec.rowLevel === 'delete-row' &&
    Object.values(fields).length > 0 &&
    Object.values(fields).every((entry) => entry !== 'delete' && entry.strategy === 'delete');
  const identityPolicy = spec.stableIdField ? fields[spec.stableIdField] : undefined;
  if (
    identityPolicy &&
    identityPolicy !== 'delete' &&
    identityPolicy.strategy !== 'retain' &&
    !deletesRow
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${spec.entityName}: stableIdField cannot be modified by field writes`,
    );
  }

  return {
    entityName: spec.entityName,
    subjectField: spec.subjectField,
    rowLevel: spec.rowLevel ?? 'delete-fields',
    fields,
    exportFields: [...exportFields],
    ...(spec.stableIdField ? { stableIdField: spec.stableIdField } : {}),
    ...(dependsOn.length ? { dependsOn: [...dependsOn] } : {}),
  };
}

function normalizeEntry(
  entityName: string,
  fieldName: string,
  entry: PolicyEntry,
  opts: CompileOptions,
): PolicyEntry {
  if (entry === 'delete') {
    return { strategy: 'delete' };
  }

  if (!entry || typeof entry !== 'object') {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidPolicy,
      `${entityName}.${fieldName}: invalid policy entry`,
    );
  }

  if (entry.strategy === 'delete') {
    return { strategy: 'delete' };
  }

  if (entry.strategy === 'anonymize') {
    if (typeof entry.replacement === 'function') {
      throw new DataSubjectError(
        DataSubjectErrorCode.AnonymizeDynamicReplacement,
        `${entityName}.${fieldName}: replacement must be static`,
      );
    }

    if (
      entry.replacement !== null &&
      typeof entry.replacement !== 'string' &&
      !(typeof entry.replacement === 'number' && Number.isFinite(entry.replacement))
    ) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${entityName}.${fieldName}: replacement must be a JSON scalar`,
      );
    }

    return { strategy: 'anonymize', replacement: entry.replacement };
  }

  if (entry.strategy === 'retain') {
    const basis = (entry as { legalBasis?: string }).legalBasis;
    if (!basis) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${entityName}.${fieldName}: retain requires legalBasis`,
      );
    }

    const validationError = validateLegalBasis(basis, {
      strict: opts.strictLegalBasis,
    });

    if (validationError) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidPolicy,
        `${entityName}.${fieldName}: ${validationError}`,
      );
    }

    return {
      strategy: 'retain',
      legalBasis: basis,
      until: entry.until,
      pseudonymize: entry.pseudonymize ?? 'none',
    };
  }

  throw new DataSubjectError(
    DataSubjectErrorCode.InvalidPolicy,
    `${entityName}.${fieldName}: unknown strategy`,
  );
}

function isName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
