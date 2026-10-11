import { createHash } from 'node:crypto';
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import { stableStringify } from './stable-json';
import type { EntityPolicy, RegisteredEntity, Strategy } from './types';

export type EffectiveRowStrategy = 'delete-row' | 'update-fields' | 'retain';

export interface ErasurePlanEntity {
  entityName: string;
  expectedRows: number;
  effectiveRowStrategy: EffectiveRowStrategy;
  deleteFields: string[];
  anonymizedFields: string[];
  retainedFields: Array<{ field: string; legalBasis: string; until?: string }>;
  verification: 'available' | 'unavailable';
}

/** Contains counts and fingerprints, never selected values or row identifiers. */
export interface ErasurePlanSummary {
  schemaVersion: 'data-subject.erasure-plan.v1';
  policyHash: string;
  scopeHash: string;
  entities: ErasurePlanEntity[];
}

export interface PolicyOutcome {
  effectiveRowStrategy: EffectiveRowStrategy;
  summaryStrategy: Strategy | 'mixed';
  deleteFields: string[];
  updateMap: Record<string, unknown>;
  anonymizedFields: string[];
  retained: ErasurePlanEntity['retainedFields'];
}

export interface EntitySnapshot {
  entry: RegisteredEntity;
  outcome: PolicyOutcome;
  ids: unknown[];
  rows: Array<{ identity: string; fields: Record<string, string> }>;
  verificationAvailable: boolean;
}

export interface ErasureSnapshot {
  plan: ErasurePlanSummary;
  entities: EntitySnapshot[];
}

export function classifyPolicy(policy: EntityPolicy): PolicyOutcome {
  const updateMap: Record<string, unknown> = Object.create(null);
  const deleteFields: string[] = [];
  const anonymizedFields: string[] = [];
  const retained: PolicyOutcome['retained'] = [];
  const strategies = new Set<Strategy>();
  for (const field of Object.keys(policy.fields).sort()) {
    const item = policy.fields[field];
    const rule = item === 'delete' ? { strategy: 'delete' as const } : item;
    strategies.add(rule.strategy);
    if (rule.strategy === 'delete') {
      deleteFields.push(field);
      updateMap[field] = null;
    } else if (rule.strategy === 'anonymize') {
      anonymizedFields.push(field);
      updateMap[field] = rule.replacement;
    } else {
      retained.push({ field, legalBasis: rule.legalBasis, ...(rule.until ? { until: rule.until } : {}) });
    }
  }
  const pureDelete = strategies.size === 1 && strategies.has('delete');
  const pureRetain = strategies.size === 0 || (strategies.size === 1 && strategies.has('retain'));
  return {
    effectiveRowStrategy: pureDelete && policy.rowLevel === 'delete-row'
      ? 'delete-row' : pureRetain ? 'retain' : 'update-fields',
    summaryStrategy: strategies.size > 1 ? 'mixed' : [...strategies][0] ?? 'retain',
    deleteFields,
    updateMap,
    anonymizedFields,
    retained,
  };
}

export function hashRegistryPolicy(registry: Registry): string {
  return fingerprint(registry.list().map(({ policy, executor }) => ({ policy, identityField: executor.identityField, scope: executor.scope })));
}

export async function captureErasureSnapshot(
  registry: Registry,
  subjectId: string,
  tenantId: string,
): Promise<ErasureSnapshot> {
  const entries = registry.list();
  // Capture the policy identity before any executor can yield to host code.
  const policyHash = hashRegistryPolicy(registry);
  const entities: EntitySnapshot[] = [];
  for (const entry of entries) {
    const outcome = classifyPolicy(entry.policy);
    const identityField = entry.executor.identityField;
    if (entry.policy.stableIdField && entry.policy.stableIdField !== identityField) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Policy and executor stable identity fields must match');
    }
    if (outcome.effectiveRowStrategy === 'update-fields' && (
      (identityField !== undefined && Object.hasOwn(outcome.updateMap, identityField)) ||
      (entry.executor.scope?.mode === 'multi-tenant' && Object.hasOwn(outcome.updateMap, entry.executor.scope.tenantField))
    )) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Field updates must preserve stable identity and tenant scope');
    }
    const selected = await entry.executor.select(subjectId, tenantId);
    const ids = identityField ? selected.map(row => row[identityField]) : [];
    const validIds = ids.every(isStableIdentity);
    const uniqueIds = new Set(ids.map(fingerprint)).size === ids.length;
    const fields = Object.keys(entry.policy.fields).sort();
    const completeFields = outcome.effectiveRowStrategy === 'delete-row' ||
      selected.every(row => fields.every(field => Object.hasOwn(row, field)));
    let verificationAvailable = typeof identityField === 'string' && identityField.trim().length > 0 &&
      typeof entry.executor.selectByIds === 'function' && validIds && uniqueIds && completeFields;
    const rows = selected.map((row, index) => ({
      identity: identityField ? fingerprint(ids[index]) : fingerprint(row),
      fields: Object.fromEntries(fields.map(field => [field, fingerprint(row[field])])),
    })).sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
    if (verificationAvailable) {
      const lookup = await entry.executor.selectByIds!(ids, tenantId);
      const lookupMap = new Map(lookup.map(row => [fingerprint(row[identityField!]), row]));
      verificationAvailable = lookup.length === rows.length && lookupMap.size === rows.length && rows.every(row => {
        const found = lookupMap.get(row.identity);
        return found !== undefined && (outcome.effectiveRowStrategy === 'delete-row' ||
          fields.every(field => Object.hasOwn(found, field) && fingerprint(found[field]) === row.fields[field]));
      });
    }
    entities.push({ entry, outcome, ids, rows, verificationAvailable });
  }
  if (hashRegistryPolicy(registry) !== policyHash) {
    throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch, 'Registry changed during inspection; create a new preview');
  }
  return {
    plan: {
      schemaVersion: 'data-subject.erasure-plan.v1',
      policyHash,
      scopeHash: fingerprint({ tenantId, subjectId, entities: entities.map(({ entry, rows }) => ({ entityName: entry.policy.entityName, rows })) }),
      entities: entities.map(({ entry, outcome, rows, verificationAvailable }) => ({
        entityName: entry.policy.entityName,
        expectedRows: rows.length,
        effectiveRowStrategy: outcome.effectiveRowStrategy,
        deleteFields: [...outcome.deleteFields],
        anonymizedFields: [...outcome.anonymizedFields],
        retainedFields: outcome.retained.map(item => ({ ...item })),
        verification: verificationAvailable ? 'available' : 'unavailable',
      })),
    },
    entities,
  };
}

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableStringify(canonicalValue(value))).digest('hex');
}

export function isStableIdentity(value: unknown): boolean {
  return (typeof value === 'string' && value.trim().length > 0) ||
    (typeof value === 'number' && Number.isFinite(value)) || typeof value === 'bigint';
}

// Tag primitives to distinguish missing/null, bigint/string, bytes and dates.
function canonicalValue(value: unknown): unknown {
  if (value === undefined) return ['undefined'];
  if (value === null) return ['null'];
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (Buffer.isBuffer(value)) return ['buffer', value.toString('base64')];
  if (value instanceof Uint8Array) return ['bytes', Buffer.from(value).toString('base64')];
  if (Array.isArray(value)) return ['array', value.map(canonicalValue)];
  if (typeof value === 'object') {
    if ('toJSON' in value && typeof value.toJSON === 'function') return ['json', canonicalValue(value.toJSON())];
    // Arrays of key/value pairs preserve keys such as __proto__ and constructor.
    return ['object', Object.keys(value).sort().map(key => [key, canonicalValue((value as Record<string, unknown>)[key])])];
  }
  return [typeof value, String(value)];
}
