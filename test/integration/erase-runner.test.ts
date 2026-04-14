import { DataSubjectError } from '../../src/errors';
import { EraseRunner } from '../../src/erase-runner';
import { Registry } from '../../src/registry';
import type { EntityExecutor } from '../../src/types';

function makeExec(initial: Record<string, unknown>[]): {
  executor: EntityExecutor;
  state: { rows: Record<string, unknown>[] };
} {
  const state = { rows: [...initial] };

  return {
    state,
    executor: {
      select: async () => state.rows.map((row) => ({ ...row })),
      erase: async () => {
        const count = state.rows.length;
        state.rows = [];
        return count;
      },
      anonymize: async (_subjectId, _tenantId, replacements) => {
        let count = 0;
        state.rows = state.rows.map((row) => {
          count += 1;
          return { ...row, ...replacements };
        });
        return count;
      },
    },
  };
}

describe('EraseRunner', () => {
  it('deletes matching rows and records stats', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'a@b.com' }]);

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: user.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(user.state.rows.length).toBe(0);
    expect(result.stats.entities).toEqual([
      { entityName: 'User', affected: 1, strategy: 'delete' },
    ]);
    expect(result.stats.verificationResidual).toEqual([]);
  });

  it('anonymizes rows with static replacement', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'a@b.com' }]);

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: {
          email: { strategy: 'anonymize', replacement: '[REDACTED]' },
        },
      },
      executor: user.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(user.state.rows[0].email).toBe('[REDACTED]');
    expect(result.stats.entities[0].strategy).toBe('anonymize');
  });

  it('retains rows and records legalBasis', async () => {
    const registry = new Registry();
    const invoice = makeExec([{ id: 'i1', amount: 100 }]);

    registry.register({
      policy: {
        entityName: 'Invoice',
        subjectField: 'customerId',
        fields: {
          amount: {
            strategy: 'retain',
            legalBasis: 'tax:KR-basic-law-sec85',
          },
        },
      },
      executor: invoice.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(invoice.state.rows.length).toBe(1);
    expect(result.stats.retained).toEqual([
      {
        entityName: 'Invoice',
        field: 'amount',
        legalBasis: 'tax:KR-basic-law-sec85',
        count: 1,
      },
    ]);
  });

  it('fails verification when delete leaves residuals', async () => {
    const registry = new Registry();
    const broken: EntityExecutor = {
      select: async () => [{ id: 'u1' }],
      erase: async () => 0,
      anonymize: async () => 0,
    };

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: broken,
    });

    const runner = new EraseRunner(registry);

    await expect(runner.run('subject_1', 'tenant_1')).rejects.toThrow(
      DataSubjectError,
    );
  });
});
