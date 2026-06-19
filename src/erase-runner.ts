import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import type {
  EntityPolicy,
  ErasureEvidenceAction,
  PolicyEntry,
  RequestStats,
  Strategy,
} from './types';

export interface EraseResult {
  stats: RequestStats;
  actions: ErasureEvidenceAction[];
}

export interface EraseRunOptions {
  afterPreScan?: (
    preScan: NonNullable<RequestStats['preScan']>,
  ) => Promise<void>;
}

export class EraseRunner {
  constructor(private readonly registry: Registry) {}

  async run(
    subjectId: string,
    tenantId: string,
    opts: EraseRunOptions = {},
  ): Promise<EraseResult> {
    const entries = this.registry.list();
    const preScan: NonNullable<RequestStats['preScan']> = [];
    const entities: RequestStats['entities'] = [];
    const retained: NonNullable<RequestStats['retained']> = [];
    const verificationResidual: NonNullable<RequestStats['verificationResidual']> =
      [];
    const postScan: NonNullable<RequestStats['postScan']> = [];
    const actions: ErasureEvidenceAction[] = [];

    for (const entry of entries) {
      const rowsBefore = await entry.executor.select(subjectId, tenantId);
      preScan.push({
        entityName: entry.policy.entityName,
        count: rowsBefore.length,
      });
    }

    await opts.afterPreScan?.(preScan);

    for (const entry of entries) {
      const outcome = classify(entry.policy);
      let affected = 0;

      if (outcome.rowStrategy === 'delete') {
        affected = await entry.executor.erase(
          subjectId,
          tenantId,
          {
            rowLevel: entry.policy.rowLevel,
            deleteFields: outcome.deleteFields,
          },
        );
      } else if (outcome.rowStrategy === 'anonymize') {
        affected = await entry.executor.anonymize(
          subjectId,
          tenantId,
          outcome.updateMap,
        );
      } else {
        const rows = await entry.executor.select(subjectId, tenantId);
        affected = rows.length;
      }

      const rowsAfter = await entry.executor.select(subjectId, tenantId);
      postScan.push({
        entityName: entry.policy.entityName,
        count: rowsAfter.length,
      });

      const retainedFields: NonNullable<
        ErasureEvidenceAction['retainedFields']
      > = [];

      for (const item of outcome.retained) {
        const retainedItem = {
          entityName: entry.policy.entityName,
          field: item.field,
          legalBasis: item.legalBasis,
          ...(item.until ? { until: item.until } : {}),
          count: rowsAfter.length,
        };
        retained.push(retainedItem);
        retainedFields.push({
          field: item.field,
          legalBasis: item.legalBasis,
          ...(item.until ? { until: item.until } : {}),
          count: rowsAfter.length,
        });
      }

      if (
        outcome.rowStrategy === 'delete' &&
        entry.policy.rowLevel === 'delete-row' &&
        rowsAfter.length > 0
      ) {
        verificationResidual.push({
          entityName: entry.policy.entityName,
          count: rowsAfter.length,
        });
      }

      const action: ErasureEvidenceAction = {
        entityName: entry.policy.entityName,
        affected,
        strategy: outcome.summaryStrategy,
        rowLevel: entry.policy.rowLevel,
      };
      if (outcome.deleteFields.length > 0) {
        action.deleteFields = [...outcome.deleteFields];
      }
      if (outcome.anonymizedFields.length > 0) {
        action.anonymizedFields = [...outcome.anonymizedFields];
      }
      if (retainedFields.length > 0) {
        action.retainedFields = retainedFields;
      }
      actions.push(action);

      entities.push({
        entityName: entry.policy.entityName,
        affected,
        strategy: outcome.summaryStrategy,
      });
    }

    if (verificationResidual.length > 0) {
      throw new DataSubjectError(
        DataSubjectErrorCode.VerificationFailed,
        `residual rows: ${verificationResidual
          .map((entry) => `${entry.entityName}(${entry.count})`)
          .join(', ')}`,
      );
    }

    return {
      stats: {
        entities,
        retained,
        verificationResidual,
        preScan,
        postScan,
      },
      actions,
    };
  }
}

interface Outcome {
  rowStrategy: Strategy;
  summaryStrategy: Exclude<RequestStats['entities'][number]['strategy'], 'export'>;
  deleteFields: string[];
  updateMap: Record<string, unknown>;
  anonymizedFields: string[];
  retained: Array<{ field: string; legalBasis: string; until?: string }>;
}

function classify(policy: EntityPolicy): Outcome {
  const updateMap: Record<string, unknown> = {};
  const deleteFields: string[] = [];
  const anonymizedFields: string[] = [];
  const retained: Outcome['retained'] = [];
  const strategies = new Set<Strategy>();

  for (const [field, entry] of Object.entries(policy.fields)) {
    const normalized = normalize(entry);
    strategies.add(normalized.strategy);

    if (normalized.strategy === 'anonymize') {
      updateMap[field] = normalized.replacement;
      anonymizedFields.push(field);
    }

    if (normalized.strategy === 'delete') {
      deleteFields.push(field);
      updateMap[field] = null;
    }

    if (normalized.strategy === 'retain') {
      retained.push({
        field,
        legalBasis: normalized.legalBasis,
        ...(normalized.until ? { until: normalized.until } : {}),
      });
    }
  }

  const rowStrategy = chooseRowStrategy(strategies);

  const summaryStrategy: Outcome['summaryStrategy'] =
    strategies.size > 1 ? 'mixed' : rowStrategy;

  return {
    rowStrategy,
    summaryStrategy,
    deleteFields,
    updateMap,
    anonymizedFields,
    retained,
  };
}

function chooseRowStrategy(strategies: Set<Strategy>): Strategy {
  if (strategies.size === 1 && strategies.has('delete')) {
    return 'delete';
  }

  if (strategies.size === 1 && strategies.has('retain')) {
    return 'retain';
  }

  return 'anonymize';
}

function normalize(entry: PolicyEntry):
  | { strategy: 'delete' }
  | { strategy: 'anonymize'; replacement: unknown }
  | { strategy: 'retain'; legalBasis: string; until?: string } {
  if (entry === 'delete') {
    return { strategy: 'delete' };
  }

  if (entry.strategy === 'anonymize') {
    return {
      strategy: 'anonymize',
      replacement: entry.replacement,
    };
  }

  if (entry.strategy === 'retain') {
    return {
      strategy: 'retain',
      legalBasis: entry.legalBasis,
      ...(entry.until ? { until: entry.until } : {}),
    };
  }

  return { strategy: 'delete' };
}
