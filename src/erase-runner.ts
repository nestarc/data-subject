import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import type { EntityPolicy, PolicyEntry, RequestStats, Strategy } from './types';

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
          entry.policy.rowLevel ?? 'delete-fields',
        );
      } else if (outcome.rowStrategy === 'anonymize') {
        affected = await entry.executor.anonymize(
          subjectId,
          tenantId,
          outcome.anonymizeMap,
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

      if (outcome.rowStrategy === 'delete' && rowsAfter.length > 0) {
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
  summaryStrategy: Strategy | 'mixed';
  anonymizeMap: Record<string, unknown>;
  retained: Array<{ field: string; legalBasis: string }>;
}

function classify(policy: EntityPolicy): Outcome {
  const anonymizeMap: Record<string, unknown> = {};
  const retained: Outcome['retained'] = [];
  const strategies = new Set<Strategy>();

  for (const [field, entry] of Object.entries(policy.fields)) {
    const normalized = normalize(entry);
    strategies.add(normalized.strategy);

    if (normalized.strategy === 'anonymize') {
      anonymizeMap[field] = (entry as { replacement: unknown }).replacement;
    }

    if (normalized.strategy === 'retain') {
      retained.push({
        field,
        legalBasis: (entry as { legalBasis: string }).legalBasis,
      });
    }
  }

  const rowStrategy: Strategy = strategies.has('delete')
    ? 'delete'
    : strategies.has('anonymize')
      ? 'anonymize'
      : 'retain';

  const summaryStrategy: Strategy | 'mixed' =
    strategies.size > 1 ? 'mixed' : rowStrategy;

  return { rowStrategy, summaryStrategy, anonymizeMap, retained };
}

function normalize(entry: PolicyEntry): { strategy: Strategy } {
  if (entry === 'delete') {
    return { strategy: 'delete' };
  }

  return { strategy: entry.strategy };
}
