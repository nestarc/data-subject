import { EraseRunner } from './erase-runner';
import { DataSubjectErrorCode } from './errors';
import { Registry } from './registry';
import type { EntityExecutor } from './types';

function fixture(executorOverrides: Partial<EntityExecutor> = {}) {
  const state = {
    rows: [
      { id: 'private-id-1', userId: 'private-subject', email: 'secret1@example.com', amount: 100 },
      { id: 'private-id-2', userId: 'private-subject', email: 'secret2@example.com', amount: 200 },
    ],
  };
  const executor: EntityExecutor = {
    identityField: 'id',
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    select: jest.fn(async () => state.rows.map((row) => ({ ...row }))),
    selectByIds: jest.fn(async (ids) => state.rows.filter((row) => ids.includes(row.id)).map((row) => ({ ...row }))),
    erase: jest.fn(async () => 2),
    anonymize: jest.fn(async () => 2),
    ...executorOverrides,
  };
  const registry = new Registry();
  registry.register({
    policy: {
      entityName: 'Invoice', subjectField: 'userId', rowLevel: 'delete-row',
      fields: {
        email: 'delete',
        amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
      },
    },
    executor,
  });
  return { state, executor, registry, runner: new EraseRunner(registry) };
}

describe('erasure preview', () => {
  it('rejects entity registration during asynchronous scope inspection', async () => {
    const { runner, registry, executor } = fixture({
      select: async () => {
        await Promise.resolve();
        registerAnother();
        return [];
      },
    });
    const registerAnother = () => registry.register({
      policy: { entityName: 'Another', subjectField: 'userId', fields: {} },
      executor,
    });
    await expect(runner.preview('private-subject', 'private-tenant')).rejects.toMatchObject({ code: DataSubjectErrorCode.PlanMismatch });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('rejects new registration by the pre-scan hook before entity writes', async () => {
    const { runner, registry, executor } = fixture();
    await expect(runner.run('private-subject', 'private-tenant', {
      afterPreScan: async () => {
        registry.register({ policy: { entityName: 'Another', subjectField: 'userId', fields: {} }, executor });
      },
    })).rejects.toMatchObject({ code: DataSubjectErrorCode.PlanMismatch });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('produces a read-only plan with the effective strategy and no row values or identifiers', async () => {
    const { runner, executor } = fixture();

    const preview = await runner.preview('private-subject', 'private-tenant');

    expect(preview).toMatchObject({
      schemaVersion: 'data-subject.erasure-plan.v1',
      policyHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      entities: [{
        entityName: 'Invoice', expectedRows: 2, effectiveRowStrategy: 'update-fields',
        deleteFields: ['email'], anonymizedFields: [],
        retainedFields: [{ field: 'amount', legalBasis: 'tax:KR-basic-law-sec85' }],
        verification: 'available',
      }],
    });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
    const serialized = JSON.stringify(preview);
    for (const secret of ['private-id-1', 'private-id-2', 'private-subject', 'private-tenant', 'secret1@example.com', 'secret2@example.com']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('produces identical hashes for identical data in a different row order', async () => {
    const { runner, state } = fixture();
    const first = await runner.preview('private-subject', 'private-tenant');
    state.rows.reverse();

    const reordered = await runner.preview('private-subject', 'private-tenant');

    expect(reordered.policyHash).toBe(first.policyHash);
    expect(reordered.scopeHash).toBe(first.scopeHash);
  });

  it('binds a plan to both the subject and tenant', async () => {
    const { runner } = fixture();
    const first = await runner.preview('private-subject', 'private-tenant');
    const otherSubject = await runner.preview('other-subject', 'private-tenant');
    const otherTenant = await runner.preview('private-subject', 'other-tenant');

    expect(otherSubject.policyHash).toBe(first.policyHash);
    expect(otherTenant.policyHash).toBe(first.policyHash);
    expect(otherSubject.scopeHash).not.toBe(first.scopeHash);
    expect(otherTenant.scopeHash).not.toBe(first.scopeHash);
  });

  it('rejects policy-field data drift even when the row count stays the same', async () => {
    const { runner, state, executor } = fixture();
    const expectedPlan = await runner.preview('private-subject', 'private-tenant');
    state.rows[0].amount = 999;

    await expect(runner.run('private-subject', 'private-tenant', { expectedPlan })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('rejects stable-identity drift even when field values and row counts are unchanged', async () => {
    const { runner, state, executor } = fixture();
    const expectedPlan = await runner.preview('private-subject', 'private-tenant');
    state.rows[0].id = 'replacement-private-id';

    await expect(runner.run('private-subject', 'private-tenant', { expectedPlan })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('rejects a changed policy before any mutation', async () => {
    const { runner, registry, executor } = fixture();
    const expectedPlan = await runner.preview('private-subject', 'private-tenant');
    const revisedRegistry = new Registry();
    const original = registry.get('Invoice')!.policy;
    revisedRegistry.register({
      policy: {
        ...original,
        fields: { ...original.fields, email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
      },
      executor,
    });

    await expect(new EraseRunner(revisedRegistry).run('private-subject', 'private-tenant', { expectedPlan })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('describes an unavailable verification capability without writing', async () => {
    const { runner, executor } = fixture({ selectByIds: undefined });

    const preview = await runner.preview('private-subject', 'private-tenant');

    expect(preview.entities[0].verification).toBe('unavailable');
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('marks a declared but nonfunctional stable lookup unavailable', async () => {
    const { runner, executor } = fixture({ selectByIds: async () => [] });

    const preview = await runner.preview('private-subject', 'private-tenant');

    expect(preview.entities[0].verification).toBe('unavailable');
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });
});
