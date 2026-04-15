import { DataSubjectErrorCode } from '../../src/errors';
import { DataSubjectService } from '../../src/data-subject.service';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import type { EntityExecutor, ErasePlan } from '../../src/types';

function makeExec(rows: Record<string, unknown>[]): EntityExecutor {
  const state = { rows: [...rows] };

  return {
    select: async () => [...state.rows],
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
    anonymize: async () => 0,
  };
}

function svc() {
  const registry = new Registry();
  registry.register({
    policy: {
      entityName: 'User',
      subjectField: 'userId',
      fields: { email: 'delete' },
    },
    executor: makeExec([{ id: 'u1', email: 'a@b.com' }]),
  });

  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const outboxEvents: Array<{ type: string; payload: unknown }> = [];

  const service = new DataSubjectService({
    registry,
    requestStorage: requests,
    artifactStorage: artifacts,
    slaDays: 30,
    idFactory: (() => {
      let count = 0;
      return () => `dsr_${++count}`;
    })(),
    clock: () => new Date('2026-01-01T00:00:00Z'),
    publishOutbox: async (type, payload) => {
      outboxEvents.push({ type, payload });
    },
  });

  return { service, requests, artifacts, outboxEvents };
}

describe('DataSubjectService', () => {
  it('export runs to completed and records artifact hash', async () => {
    const { service, requests, outboxEvents } = svc();

    const request = await service.export('subject_1', 'tenant_1');

    expect(request.state).toBe('completed');
    expect(request.artifactHash).toMatch(/^[a-f0-9]{64}$/);

    const stored = await requests.findById(request.id);
    expect(stored?.state).toBe('completed');
    expect(outboxEvents).toContainEqual({
      type: 'data_subject.request_completed',
      payload: expect.objectContaining({
        requestId: request.id,
        state: 'completed',
        artifactHash: request.artifactHash,
      }),
    });
  });

  it('erase publishes a tombstone outbox event with no PII', async () => {
    const { service, outboxEvents } = svc();

    await service.erase('subject_1', 'tenant_1');

    const event = outboxEvents.find(
      (item) => item.type === 'data_subject.erasure_requested',
    );

    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      subjectId: 'subject_1',
      tenantId: 'tenant_1',
    });

    const json = JSON.stringify(event?.payload);
    expect(json).not.toContain('a@b.com');
  });

  it('erase completes successfully with artifact hash', async () => {
    const { service } = svc();

    const request = await service.erase('subject_1', 'tenant_1');

    expect(request.state).toBe('completed');
    expect(request.stats?.entities[0]).toMatchObject({
      entityName: 'User',
      affected: 1,
    });
    expect(request.artifactHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sets dueAt to createdAt + slaDays', async () => {
    const { service } = svc();

    const request = await service.export('subject_1', 'tenant_1');

    expect(request.dueAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('getRequest throws a typed error for missing ids', async () => {
    const { service } = svc();

    await expect(service.getRequest('missing')).rejects.toMatchObject({
      code: DataSubjectErrorCode.RequestNotFound,
    });
  });

  it('marks request failed when runner throws', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: {
        select: async () => [{ id: 'u1' }],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });

    const service = new DataSubjectService({
      registry,
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      clock: () => new Date('2026-01-01T00:00:00Z'),
    });

    const request = await service.erase('subject_1', 'tenant_1');

    expect(request.state).toBe('failed');
    expect(request.failureReason).toMatch(/residual/);
  });

  it('publishes request_failed for export errors', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: {
        select: async () => {
          throw 'boom';
        },
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });

    const outboxEvents: Array<{ type: string; payload: unknown }> = [];
    const service = new DataSubjectService({
      registry,
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      clock: () => new Date('2026-01-01T00:00:00Z'),
      publishOutbox: async (type, payload) => {
        outboxEvents.push({ type, payload });
      },
    });

    const request = await service.export('subject_1', 'tenant_1');

    expect(request.state).toBe('failed');
    expect(request.failureReason).toBe('boom');
    expect(outboxEvents).toContainEqual({
      type: 'data_subject.request_failed',
      payload: {
        requestId: request.id,
        failureReason: 'boom',
      },
    });
  });

  it('uses runInTransaction so integrations can roll back late erase failures', async () => {
    const state = { rows: [{ id: 'u1', email: 'a@b.com' }] };
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        rowLevel: 'delete-row',
        fields: { email: 'delete' },
      },
      executor: {
        select: async () => [...state.rows],
        erase: async () => {
          const count = state.rows.length;
          state.rows = [];
          return count;
        },
        anonymize: async () => 0,
      },
    });

    let transactionCalls = 0;
    const service = new DataSubjectService({
      registry,
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      clock: () => new Date('2026-01-01T00:00:00Z'),
      runInTransaction: async (work) => {
        transactionCalls += 1;
        const snapshot = state.rows.map((row) => ({ ...row }));
        try {
          return await work();
        } catch (error) {
          state.rows = snapshot;
          throw error;
        }
      },
      publishOutbox: async (type) => {
        if (type === 'data_subject.request_completed') {
          throw new Error('outbox commit failed');
        }
      },
    });

    const request = await service.erase('subject_1', 'tenant_1');

    expect(transactionCalls).toBe(1);
    expect(request.state).toBe('failed');
    expect(request.failureReason).toBe('outbox commit failed');
    expect(state.rows).toEqual([{ id: 'u1', email: 'a@b.com' }]);
  });
});
