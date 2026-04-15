import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import type {
  EntityPolicy,
  PolicyEntry,
  RequestStats,
  Strategy,
} from './types';

export interface EraseResult {
  stats: RequestStats;
}

export class EraseRunner {
  constructor(private readonly registry: Registry) {}

  async run(subjectId: string, tenantId: string): Promise<EraseResult> {
    const entities: RequestStats['entities'] = [];
    const retained: NonNullable<RequestStats['retained']> = [];
    const verificationResidual: NonNullable<RequestStats['verificationResidual']> =
      [];

    for (const entry of this.registry.list()) {
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

      for (const item of outcome.retained) {
        retained.push({
          entityName: entry.policy.entityName,
          field: item.field,
          legalBasis: item.legalBasis,
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

    return { stats: { entities, retained, verificationResidual } };
  }
}

interface Outcome {
  rowStrategy: Strategy;
  summaryStrategy: RequestStats['entities'][number]['strategy'];
  deleteFields: string[];
  updateMap: Record<string, unknown>;
  retained: Array<{ field: string; legalBasis: string }>;
}

function classify(policy: EntityPolicy): Outcome {
  const updateMap: Record<string, unknown> = {};
  const deleteFields: string[] = [];
  const retained: Outcome['retained'] = [];
  const strategies = new Set<Strategy>();

  for (const [field, entry] of Object.entries(policy.fields)) {
    const normalized = normalize(entry);
    strategies.add(normalized.strategy);

    if (normalized.strategy === 'anonymize') {
      updateMap[field] = normalized.replacement;
    }

    if (normalized.strategy === 'delete') {
      deleteFields.push(field);
      updateMap[field] = null;
    }

    if (normalized.strategy === 'retain') {
      retained.push({
        field,
        legalBasis: normalized.legalBasis,
      });
    }
  }

  const rowStrategy = chooseRowStrategy(strategies);

  const summaryStrategy: Outcome['summaryStrategy'] =
    strategies.size > 1 ? 'mixed' : rowStrategy;

  return { rowStrategy, summaryStrategy, deleteFields, updateMap, retained };
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
  | { strategy: 'retain'; legalBasis: string } {
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
    };
  }

  return { strategy: 'delete' };
}
