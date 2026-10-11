import { DataSubjectError, DataSubjectErrorCode } from '../../src/errors';
import { EraseRunner, ErasureVerificationError } from '../../src/erase-runner';
import { Registry } from '../../src/registry';
import type { EntityExecutor, ErasePlan } from '../../src/types';

function makeExec(initial: Record<string, unknown>[]): {
  executor: EntityExecutor;
  state: { rows: Record<string, unknown>[] };
} {
  const state = { rows: [...initial] };

  return {
    state,
    executor: {
      identityField: 'id',
      selectByIds: async (ids) => state.rows.filter((row) => ids.includes(row.id as string)).map((row) => ({ ...row })),
      select: async () => state.rows.map((row) => ({ ...row })),
      erase: async (_subjectId, _tenantId, plan: ErasePlan) => {
        const count = state.rows.length;
        if (plan.rowLevel === 'delete-row') {
          state.rows = [];
          return count;
        }

        state.rows = state.rows.map((row) => {
          const next = { ...row };
          for (const field of plan.deleteFields) {
            next[field] = null;
          }
          return next;
        });
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
        rowLevel: 'delete-row',
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

  it('defaults delete strategy to field deletion without failing verification', async () => {
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

    expect(user.state.rows).toEqual([{ id: 'u1', email: null }]);
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

  it('downgrades mixed delete and retain rows to field updates', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'a@b.com', amount: 100 }]);

    registry.register({
      policy: {
        entityName: 'Invoice',
        subjectField: 'customerId',
        rowLevel: 'delete-row',
        fields: {
          email: 'delete',
          amount: {
            strategy: 'retain',
            legalBasis: 'tax:KR-basic-law-sec85',
          },
        },
      },
      executor: user.executor,
    });

    const runner = new EraseRunner(registry);
    const result = await runner.run('subject_1', 'tenant_1');

    expect(user.state.rows).toEqual([{ id: 'u1', email: null, amount: 100 }]);
    expect(result.stats.entities).toEqual([
      { entityName: 'Invoice', affected: 1, strategy: 'mixed' },
    ]);
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
      identityField: 'id',
      selectByIds: async () => [{ id: 'u1' }],
      select: async () => [{ id: 'u1' }],
      erase: async () => 0,
      anonymize: async () => 0,
    };

    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: broken,
    });

    const runner = new EraseRunner(registry);

    await expect(runner.run('subject_1', 'tenant_1')).rejects.toThrow(
      DataSubjectError,
    );
  });

  it('rejects a no-op field deletion even when the executor reports affected rows', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    user.executor.erase = jest.fn(async () => 1);
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
    expect(user.state.rows[0].email).toBe('private@example.com');
  });

  it('rejects a no-op static anonymization', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    user.executor.anonymize = jest.fn(async () => 1);
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: { email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
      },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('carries failed verification details without exposing source values or identifiers', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'private-row-id', email: 'private@example.com' }]);
    user.executor.anonymize = async () => 1;
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: { email: { strategy: 'anonymize', replacement: 'replacement-private-value' } },
      },
      executor: user.executor,
    });

    const error: unknown = await new EraseRunner(registry).run('private-subject', 'private-tenant')
      .then(() => { throw new Error('Expected verification failure'); }, (failure: unknown) => failure);

    expect(error).toBeInstanceOf(ErasureVerificationError);
    const verificationError = error as ErasureVerificationError;
    expect(verificationError.stats.verificationResidual).toEqual([{ entityName: 'User', count: 1 }]);
    expect(verificationError.actions[0].verification).toEqual({
      status: 'failed', checkedRows: 1,
      fields: [{ field: 'email', strategy: 'anonymize', checked: 1, status: 'failed' }],
    });
    expect(verificationError.stats.policyHash).toMatch(/^[a-f0-9]{64}$/);
    const serialized = JSON.stringify({ ...verificationError, message: verificationError.message });
    for (const secret of ['private-row-id', 'private@example.com', 'private-subject', 'private-tenant', 'replacement-private-value']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('rejects unintended changes to retained values in mixed policies', async () => {
    const registry = new Registry();
    const invoice = makeExec([{ id: 'i1', email: 'private@example.com', amount: 100 }]);
    invoice.executor.anonymize = async () => {
      invoice.state.rows = [{ id: 'i1', email: null, amount: 0 }];
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'Invoice', subjectField: 'customerId',
        fields: {
          email: 'delete',
          amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
        },
      },
      executor: invoice.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('verifies retained records after every entity has executed, catching later cascades', async () => {
    const registry = new Registry();
    const invoice = makeExec([{ id: 'i1', amount: 100 }]);
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    registry.register({
      policy: {
        entityName: 'Invoice', subjectField: 'customerId',
        fields: { amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' } },
      },
      executor: invoice.executor,
    });
    user.executor.erase = async () => {
      user.state.rows = [];
      invoice.state.rows = [];
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId', rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('detects an in-place change to retained structured values', async () => {
    const registry = new Registry();
    const details = { total: 100, currency: 'KRW' };
    const invoice = makeExec([{ id: 'i1', email: 'private@example.com', details }]);
    invoice.executor.anonymize = async () => {
      invoice.state.rows[0].email = null;
      details.total = 0;
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'Invoice', subjectField: 'customerId',
        fields: {
          email: 'delete',
          details: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
        },
      },
      executor: invoice.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('detects changes to retained JSON values even for own __proto__ keys', async () => {
    const registry = new Registry();
    const details = JSON.parse('{"__proto__":{"secret":"original-private-value"}}') as Record<string, { secret: string }>;
    const invoice = makeExec([{ id: 'i1', email: 'private@example.com', details }]);
    invoice.executor.anonymize = async () => {
      invoice.state.rows[0].email = null;
      details['__proto__'].secret = 'changed-private-value';
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'Invoice', subjectField: 'customerId',
        fields: {
          email: 'delete',
          details: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
        },
      },
      executor: invoice.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it.each(['id', 'tenantId'])('rejects a policy that would mutate the %s scope identity', async (field) => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', tenantId: 'tenant_1', email: 'private@example.com' }]);
    user.executor.scope = { mode: 'multi-tenant', tenantField: 'tenantId' };
    const erase = jest.spyOn(user.executor, 'erase');
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { [field]: 'delete' } },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.InvalidPolicy,
    });
    expect(erase).not.toHaveBeenCalled();
  });

  it('uses stable identities when anonymization removes the subject lookup key', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', userId: 'subject_1', email: 'private@example.com' }]);
    user.executor.select = async (subjectId) => user.state.rows
      .filter((row) => row.userId === subjectId).map((row) => ({ ...row }));
    user.executor.anonymize = async () => {
      user.state.rows[0].userId = '[REDACTED]';
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: {
          userId: { strategy: 'anonymize', replacement: '[REDACTED]' },
          email: { strategy: 'anonymize', replacement: '[REDACTED]' },
        },
      },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
    expect(await user.executor.select('subject_1', 'tenant_1')).toEqual([]);
    expect(user.state.rows[0].email).toBe('private@example.com');
  });

  it('counts successfully verified rows after subject keys are anonymized', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', userId: 'subject_1', email: 'private@example.com' }]);
    user.executor.select = async (subjectId) => user.state.rows
      .filter((row) => row.userId === subjectId).map((row) => ({ ...row }));
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: {
          userId: { strategy: 'anonymize', replacement: '[REDACTED]' },
          email: 'delete',
        },
      },
      executor: user.executor,
    });

    const result = await new EraseRunner(registry).run('subject_1', 'tenant_1');

    expect(result.actions[0]).toMatchObject({
      effectiveRowStrategy: 'update-fields',
      verification: {
        status: 'verified', checkedRows: 1,
        fields: expect.arrayContaining([
          expect.objectContaining({ field: 'email', strategy: 'delete', checked: 1, status: 'verified' }),
          expect.objectContaining({ field: 'userId', strategy: 'anonymize', checked: 1, status: 'verified' }),
        ]),
      },
    });
  });

  it.each([
    { label: 'identity field metadata', rows: [{ id: 'u1', email: 'private@example.com' }], remove: 'identityField' },
    { label: 'identity lookup', rows: [{ id: 'u1', email: 'private@example.com' }], remove: 'selectByIds' },
    { label: 'identity value', rows: [{ email: 'private@example.com' }], remove: undefined },
    { label: 'unique identities', rows: [{ id: 'u1', email: 'a' }, { id: 'u1', email: 'b' }], remove: undefined },
  ])('fails closed before writing without $label', async ({ rows, remove }) => {
    const registry = new Registry();
    const user = makeExec(rows);
    if (remove === 'identityField') delete user.executor.identityField;
    if (remove === 'selectByIds') delete user.executor.selectByIds;
    const erase = jest.spyOn(user.executor, 'erase');
    const anonymize = jest.spyOn(user.executor, 'anonymize');
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationUnavailable,
    });
    expect(erase).not.toHaveBeenCalled();
    expect(anonymize).not.toHaveBeenCalled();
  });

  it('preflights every entity before allowing any mutation', async () => {
    const registry = new Registry();
    const first = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    const second = makeExec([{ email: 'other@example.com' }]);
    const erase = jest.spyOn(first.executor, 'erase');
    for (const [name, fixture] of [['First', first], ['Second', second]] as const) {
      registry.register({
        policy: { entityName: name, subjectField: 'userId', fields: { email: 'delete' } },
        executor: fixture.executor,
      });
    }

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationUnavailable,
    });
    expect(erase).not.toHaveBeenCalled();
    expect(first.state.rows[0].email).toBe('private@example.com');
  });

  it('rejects a nonfunctional stable lookup before a no-op row deletion can appear verified', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    user.executor.selectByIds = async () => [];
    user.executor.erase = jest.fn(async () => 0);
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId', rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationUnavailable,
    });
    expect(user.executor.erase).not.toHaveBeenCalled();
  });

  it('rejects a stable lookup that omits retained policy fields before writing', async () => {
    const registry = new Registry();
    const invoice = makeExec([{ id: 'i1', email: 'private@example.com', amount: 100 }]);
    invoice.executor.selectByIds = async () => [{ id: 'i1', email: 'private@example.com' }];
    const anonymize = jest.spyOn(invoice.executor, 'anonymize');
    registry.register({
      policy: {
        entityName: 'Invoice', subjectField: 'customerId',
        fields: {
          email: 'delete',
          amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
        },
      },
      executor: invoice.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationUnavailable,
    });
    expect(anonymize).not.toHaveBeenCalled();
  });

  it('rejects an undeleted row whose stable identity changed during a purported row deletion', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    user.executor.erase = async () => {
      user.state.rows[0].id = 'u2';
      return 1;
    };
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId', rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('rejects mutation of a stable identity instead of treating disappearance as successful field deletion', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    user.executor.erase = async () => {
      user.state.rows = [{ id: 'u2', email: null }];
      return 1;
    };
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    await expect(new EraseRunner(registry).run('subject_1', 'tenant_1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.VerificationFailed,
    });
  });

  it('verifies zero-row operations with a capable executor', async () => {
    const registry = new Registry();
    const user = makeExec([]);
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    const result = await new EraseRunner(registry).run('subject_1', 'tenant_1');

    expect(result.actions[0].verification).toMatchObject({ status: 'verified', checkedRows: 0 });
  });

  it('labels an explicitly permitted unsupported executor as unverified', async () => {
    const registry = new Registry();
    const user = makeExec([{ id: 'u1', email: 'private@example.com' }]);
    delete user.executor.identityField;
    delete user.executor.selectByIds;
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: user.executor,
    });

    const result = await new EraseRunner(registry).run('subject_1', 'tenant_1', { allowUnverified: true });

    expect(user.state.rows[0].email).toBeNull();
    expect(result.actions[0].verification).toMatchObject({ status: 'unverified' });
  });
});
