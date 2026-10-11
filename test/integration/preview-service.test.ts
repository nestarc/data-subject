import { DataSubjectService, type DataSubjectServiceDeps } from '../../src/data-subject.service';
import { DataSubjectErrorCode } from '../../src/errors';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import type { EntityExecutor } from '../../src/types';

function setup(executorOverrides: Partial<EntityExecutor> = {}) {
  const state = {
    now: new Date('2026-10-11T01:00:00Z'),
    rows: [{ id: 'private-row-id', userId: 'subject_1', tenantId: 'tenant_1', email: 'private@example.com' }] as Array<Record<string, unknown>>,
  };
  const executor: EntityExecutor = {
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    identityField: 'id',
    select: jest.fn(async (subjectId, tenantId) => state.rows
      .filter(row => row.userId === subjectId && row.tenantId === tenantId).map(row => ({ ...row }))),
    selectByIds: jest.fn(async (ids, tenantId) => state.rows
      .filter(row => ids.includes(row.id) && row.tenantId === tenantId).map(row => ({ ...row }))),
    erase: jest.fn(async (subjectId, tenantId, plan) => {
      const selected = state.rows.filter(row => row.userId === subjectId && row.tenantId === tenantId);
      for (const row of selected) for (const field of plan.deleteFields) row[field] = null;
      return selected.length;
    }),
    anonymize: jest.fn(async (subjectId, tenantId, replacements) => {
      const selected = state.rows.filter(row => row.userId === subjectId && row.tenantId === tenantId);
      for (const row of selected) Object.assign(row, replacements);
      return selected.length;
    }),
    ...executorOverrides,
  };
  const registry = new Registry();
  registry.register({
    policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
    executor,
  });
  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const insert = jest.spyOn(requests, 'insert');
  const update = jest.spyOn(requests, 'update');
  const put = jest.spyOn(artifacts, 'put');
  const outbox = jest.fn(async () => {});
  const audit = jest.fn(async () => {});
  const deps: DataSubjectServiceDeps = {
    registry, requestStorage: requests, artifactStorage: artifacts, slaDays: 30,
    previewSigningKey: 'test-shared-preview-key-at-least-32-bytes',
    clock: () => new Date(state.now),
    publishOutbox: outbox, publishAudit: audit,
    runInTransaction: async <T>(work: () => Promise<T>) => {
      const original = structuredClone(state.rows);
      try { return await work(); } catch (error) { state.rows = original; throw error; }
    },
  };
  const service = new DataSubjectService(deps);
  return { state, executor, deps, service, insert, update, put, outbox, audit };
}

describe('DataSubjectService erasure previews', () => {
  it('returns a signed expiring plan without entity writes, request writes, artifacts, or callbacks', async () => {
    const { service, executor, insert, update, put, outbox, audit } = setup();

    const preview = await service.previewErase('subject_1', 'tenant_1', { ttlMs: 60_000 });

    expect(preview).toMatchObject({
      schemaVersion: 'data-subject.preview.v1',
      subjectId: 'subject_1', tenantId: 'tenant_1',
      issuedAt: '2026-10-11T01:00:00.000Z', expiresAt: '2026-10-11T01:01:00.000Z',
      signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      plan: { entities: [{ entityName: 'User', expectedRows: 1, effectiveRowStrategy: 'update-fields' }] },
    });
    for (const operation of [executor.erase, executor.anonymize, insert, update, put, outbox, audit]) {
      expect(operation).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(preview)).not.toContain('private@example.com');
    expect(JSON.stringify(preview)).not.toContain('private-row-id');
  });

  it('rejects an altered signed plan before creating a request', async () => {
    const { service, executor, insert } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');
    preview.plan.entities[0].expectedRows = 0;

    await expect(service.erase('subject_1', 'tenant_1', { preview })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(executor.erase).not.toHaveBeenCalled();
  });

  it.each([
    { subjectId: 'other_subject', tenantId: 'tenant_1' },
    { subjectId: 'subject_1', tenantId: 'other_tenant' },
  ])('rejects use for $subjectId in $tenantId before creating a request', async ({ subjectId, tenantId }) => {
    const { service, executor, insert } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');

    await expect(service.erase(subjectId, tenantId, { preview })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(executor.erase).not.toHaveBeenCalled();
  });

  it('rejects the preview at its exact expiry time before creating a request', async () => {
    const { service, state, executor, insert } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1', { ttlMs: 1_000 });
    state.now = new Date('2026-10-11T01:00:01Z');

    await expect(service.erase('subject_1', 'tenant_1', { preview })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanExpired,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(executor.erase).not.toHaveBeenCalled();
  });

  it('rechecks expiry inside the transaction immediately before execution', async () => {
    const { service, state, deps, executor } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1', { ttlMs: 1_000 });
    const delayed = new DataSubjectService({
      ...deps,
      runInTransaction: async <T>(work: () => Promise<T>) => {
        state.now = new Date('2026-10-11T01:00:01Z');
        return work();
      },
    });

    const result = await delayed.erase('subject_1', 'tenant_1', { preview });

    expect(result).toMatchObject({ state: 'failed', failureReason: DataSubjectErrorCode.PlanExpired });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('rejects same-count data drift before invoking any entity mutation', async () => {
    const { service, state, executor } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');
    state.rows[0].email = 'changed@example.com';

    const result = await service.erase('subject_1', 'tenant_1', { preview });

    expect(result).toMatchObject({ state: 'failed', failureReason: DataSubjectErrorCode.PlanMismatch });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
    expect(state.rows[0].email).toBe('changed@example.com');
  });

  it('rejects a policy change between planning and execution', async () => {
    const { service, deps, executor } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: { email: { strategy: 'anonymize', replacement: '[REDACTED]' } },
      },
      executor,
    });

    const result = await new DataSubjectService({ ...deps, registry }).erase('subject_1', 'tenant_1', { preview });

    expect(result).toMatchObject({ state: 'failed', failureReason: DataSubjectErrorCode.PlanMismatch });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('reports missing stable-identity verification and prevents entity writes', async () => {
    const { service, executor } = setup({ identityField: undefined, selectByIds: undefined });
    const preview = await service.previewErase('subject_1', 'tenant_1');
    expect(preview.plan.entities[0].verification).toBe('unavailable');

    const result = await service.erase('subject_1', 'tenant_1', { preview });

    expect(result).toMatchObject({ state: 'failed', failureReason: DataSubjectErrorCode.VerificationUnavailable });
    expect(executor.erase).not.toHaveBeenCalled();
    expect(executor.anonymize).not.toHaveBeenCalled();
  });

  it('accepts a valid preview in another service instance sharing the signing key', async () => {
    const { service, deps, state, executor } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');

    const result = await new DataSubjectService(deps).erase('subject_1', 'tenant_1', { preview });

    expect(result.state).toBe('completed');
    expect(state.rows[0].email).toBeNull();
    expect(executor.erase).toHaveBeenCalledTimes(1);
    expect(result.stats?.verification?.[0].status).toBe('verified');
  });

  it('rejects a preview signed by another key', async () => {
    const { service, deps, executor, insert } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');
    const otherInstance = new DataSubjectService({ ...deps, previewSigningKey: 'a-different-test-key-at-least-32-bytes' });

    await expect(otherInstance.erase('subject_1', 'tenant_1', { preview })).rejects.toMatchObject({
      code: DataSubjectErrorCode.PlanMismatch,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(executor.erase).not.toHaveBeenCalled();
  });

  it('requires a transaction boundary before consuming a preview', async () => {
    const { service, deps, executor, insert } = setup();
    const preview = await service.previewErase('subject_1', 'tenant_1');
    const withoutTransaction = new DataSubjectService({ ...deps, runInTransaction: undefined });

    await expect(withoutTransaction.erase('subject_1', 'tenant_1', { preview })).rejects.toMatchObject({
      code: DataSubjectErrorCode.DurableExecutionRequired,
    });
    expect(insert).not.toHaveBeenCalled();
    expect(executor.erase).not.toHaveBeenCalled();
  });
});
