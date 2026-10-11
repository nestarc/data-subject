import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { captureErasureSnapshot, fingerprint, hashRegistryPolicy, type EntitySnapshot, type ErasurePlanSummary } from './erasure-plan';
import type { Registry } from './registry';
import { stableStringify } from './stable-json';
import { matchesReplacement } from './value-verification';
import type { EntityVerification, ErasureEvidenceAction, RequestStats, Strategy } from './types';

export interface EraseResult {
  stats: RequestStats;
  actions: ErasureEvidenceAction[];
}

/** Carries only policy names, counts and statuses, never selected row data. */
export class ErasureVerificationError extends DataSubjectError {
  constructor(readonly result: EraseResult) {
    super(DataSubjectErrorCode.VerificationFailed, 'Erasure verification failed; inspect sanitized verification results');
  }
  get stats(): RequestStats { return this.result.stats; }
  get actions(): ErasureEvidenceAction[] { return this.result.actions; }
}

export interface EraseRunOptions {
  afterPreScan?: (preScan: NonNullable<RequestStats['preScan']>) => Promise<void>;
  expectedPlan?: ErasurePlanSummary;
  /** Explicit compatibility mode; its evidence is marked unverified. */
  allowUnverified?: boolean;
}

export class EraseRunner {
  constructor(private readonly registry: Registry) {}

  async preview(subjectId: string, tenantId: string): Promise<ErasurePlanSummary> {
    return (await captureErasureSnapshot(this.registry, subjectId, tenantId)).plan;
  }

  async run(subjectId: string, tenantId: string, opts: EraseRunOptions = {}): Promise<EraseResult> {
    const snapshot = await captureErasureSnapshot(this.registry, subjectId, tenantId);
    if (opts.expectedPlan && stableStringify(snapshot.plan) !== stableStringify(opts.expectedPlan)) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch, 'The erasure scope or policy has changed; create a new preview');
    }
    if (!opts.allowUnverified && snapshot.entities.some(entity => !entity.verificationAvailable)) {
      throw new DataSubjectError(DataSubjectErrorCode.VerificationUnavailable, 'Every executor requires unique stable identities and selectByIds for erasure verification');
    }
    const preScan = snapshot.entities.map(({ entry, rows }) => ({ entityName: entry.policy.entityName, count: rows.length }));
    await opts.afterPreScan?.(preScan);
    if (hashRegistryPolicy(this.registry) !== snapshot.plan.policyHash) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch, 'Registry changed before execution; create a new preview');
    }
    const actions: ErasureEvidenceAction[] = [];
    for (const entity of snapshot.entities) {
      const { entry, outcome, rows } = entity;
      let affected = rows.length;
      if (outcome.effectiveRowStrategy === 'delete-row') {
        affected = await entry.executor.erase(subjectId, tenantId, { rowLevel: 'delete-row', deleteFields: outcome.deleteFields });
      } else if (outcome.effectiveRowStrategy === 'update-fields') {
        if (outcome.anonymizedFields.length === 0 && outcome.retained.length === 0) {
          affected = await entry.executor.erase(subjectId, tenantId, { rowLevel: 'delete-fields', deleteFields: outcome.deleteFields });
        } else {
          affected = await entry.executor.anonymize(subjectId, tenantId, outcome.updateMap);
        }
      }
      actions.push({
        entityName: entry.policy.entityName,
        affected,
        strategy: outcome.summaryStrategy,
        rowLevel: entry.policy.rowLevel,
        effectiveRowStrategy: outcome.effectiveRowStrategy,
        ...(outcome.deleteFields.length ? { deleteFields: [...outcome.deleteFields] } : {}),
        ...(outcome.anonymizedFields.length ? { anonymizedFields: [...outcome.anonymizedFields] } : {}),
        ...(outcome.retained.length ? { retainedFields: outcome.retained.map(item => ({ ...item, count: rows.length })) } : {}),
        verification: { status: 'unverified', checkedRows: 0, fields: [] },
      });
    }
    // Verify after ALL writes: later deletes/cascades must not invalidate an earlier retain check.
    const postScan: NonNullable<RequestStats['postScan']> = [];
    const verificationResidual: NonNullable<RequestStats['verificationResidual']> = [];
    for (const [index, entity] of snapshot.entities.entries()) {
      const after = entity.verificationAvailable
        ? await entity.entry.executor.selectByIds!(entity.ids, tenantId)
        : await entity.entry.executor.select(subjectId, tenantId);
      postScan.push({ entityName: entity.entry.policy.entityName, count: after.length });
      const verification = verifyEntity(entity, after);
      if (entity.outcome.effectiveRowStrategy === 'delete-row') {
        const remaining = await entity.entry.executor.select(subjectId, tenantId);
        if (remaining.length > 0) {
          postScan[postScan.length - 1].count = Math.max(after.length, remaining.length);
          verification.failedRows = Math.max(verification.failedRows, remaining.length);
          verification.result.status = 'failed';
          verification.result.fields = verification.result.fields.map(field => ({ ...field, status: 'failed' }));
        }
      }
      actions[index].verification = verification.result;
      if (verification.failedRows > 0) verificationResidual.push({ entityName: entity.entry.policy.entityName, count: verification.failedRows });
    }
    const result: EraseResult = {
      stats: {
        policyHash: snapshot.plan.policyHash,
        entities: actions.map(({ entityName, affected, strategy }) => ({ entityName, affected, strategy })),
        retained: actions.flatMap(action => (action.retainedFields ?? []).map(field => ({ entityName: action.entityName, ...field }))),
        verification: actions.map(({ entityName, verification }) => ({ entityName, ...verification! })),
        verificationResidual,
        preScan,
        postScan,
      },
      actions,
    };
    if (verificationResidual.length) throw new ErasureVerificationError(result);
    return result;
  }
}

function verifyEntity(snapshot: EntitySnapshot, after: Record<string, unknown>[]): {
  result: EntityVerification;
  failedRows: number;
} {
  const { entry, outcome, rows } = snapshot;
  const fields = Object.keys(entry.policy.fields).sort();
  const strategy = (field: string): Strategy => {
    const rule = entry.policy.fields[field];
    return rule === 'delete' ? 'delete' : rule.strategy;
  };
  if (!snapshot.verificationAvailable) {
    return { failedRows: 0, result: { status: 'unverified', checkedRows: 0, fields: fields.map(field => ({ field, strategy: strategy(field), checked: 0, status: 'unverified' })) } };
  }
  const afterByIdentity = new Map(after.map(row => [fingerprint(row[entry.executor.identityField!]), row]));
  const failed = new Set<string>();
  const failedFields = new Set<string>();
  if (afterByIdentity.size !== after.length) {
    failed.add('duplicate-result');
    fields.forEach(field => failedFields.add(field));
  }
  const originalIds = new Set(rows.map(row => row.identity));
  for (const identity of afterByIdentity.keys()) if (!originalIds.has(identity)) {
    failed.add(identity);
    fields.forEach(field => failedFields.add(field));
  }
  for (const before of rows) {
    const row = afterByIdentity.get(before.identity);
    if (outcome.effectiveRowStrategy === 'delete-row') {
      if (row) {
        failed.add(before.identity);
        fields.forEach(field => failedFields.add(field));
      }
    } else if (!row) {
      failed.add(before.identity);
      fields.forEach(field => failedFields.add(field));
    } else {
      for (const field of fields) {
        const matches = strategy(field) === 'retain'
          ? fingerprint(row[field]) === before.fields[field]
          : matchesReplacement(row[field], outcome.updateMap[field]);
        if (!Object.hasOwn(row, field) || !matches) {
          failed.add(before.identity);
          failedFields.add(field);
        }
      }
    }
  }
  return {
    failedRows: failed.size,
    result: {
      status: failed.size > 0 ? 'failed' : 'verified',
      checkedRows: rows.length,
      fields: fields.map(field => ({ field, strategy: strategy(field), checked: rows.length, status: failedFields.has(field) ? 'failed' : 'verified' })),
    },
  };
}
