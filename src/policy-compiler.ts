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
}

export function compilePolicy(
  spec: PolicySpec,
  opts: CompileOptions = {},
): EntityPolicy {
  const fields: Record<string, PolicyEntry> = {};

  for (const [name, raw] of Object.entries(spec.fields)) {
    fields[name] = normalizeEntry(spec.entityName, name, raw, opts);
  }

  return {
    entityName: spec.entityName,
    subjectField: spec.subjectField,
    rowLevel: spec.rowLevel ?? 'delete-fields',
    fields,
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
