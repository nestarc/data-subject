import { DataSubjectErrorCode } from '../../src/errors';
import { erasureEvidenceArtifactKey, sha256Hex } from '../../src/artifacts';
import { DataSubjectService } from '../../src/data-subject.service';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import type { EntityExecutor, ErasePlan } from '../../src/types';

function makeExec(rows: Record<string, unknown>[]): EntityExecutor {
  const state = { rows: [...rows] };

  return {
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
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
      exportFields: ['email'],
    },
    executor: makeExec([{ id: 'u1', email: 'a@b.com' }]),
  });

  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const outboxEvents: Array<{ type: string; payload: unknown }> = [];
  const auditEvents: Array<{ type: string; payload: unknown }> = [];

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
    publishAudit: async (type, payload) => {
      auditEvents.push({ type, payload });
    },
  });

  return { service, requests, artifacts, outboxEvents, auditEvents };
}

describe('DataSubjectService', () => {
  it('export runs to completed and records artifact hash', async () => {
    const { service, requests, outboxEvents } = svc();

    const request = await service.export('subject_1', 'tenant_1');

    expect(request.state).toBe('completed');
    expect(request.artifactHash).toMatch(/^[a-f0-9]{64}$/);

    const stored = await requests.findById(request.id, 'tenant_1');
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

    const event = outboxEvents.find((item) => item.type === 'data_subject.erasure_requested');

    expect(event).toBeDefined();
    expect(event?.payload).toMatchObject({
      subjectId: 'subject_1',
      tenantId: 'tenant_1',
    });

    const json = JSON.stringify(event?.payload);
    expect(json).not.toContain('a@b.com');
  });

  it('erase completes successfully with artifact hash', async () => {
    const { service, artifacts } = svc();

    const request = await service.erase('subject_1', 'tenant_1');
    const key = erasureEvidenceArtifactKey('tenant_1', request.id);
    const stored = await artifacts.get(key);

    expect(request.state).toBe('completed');
    expect(request.stats?.entities[0]).toMatchObject({
      entityName: 'User',
      affected: 1,
    });
    expect(request.stats?.preScan).toEqual([{ entityName: 'User', count: 1 }]);
    expect(request.stats?.postScan).toEqual([{ entityName: 'User', count: 1 }]);
    expect(request.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.artifactUrl).toBe(`memory://${key}`);
    expect(stored).not.toBeNull();
    expect(request.artifactHash).toBe(sha256Hex(stored!.body));

    const body = stored!.body.toString('utf8');
    expect(body).not.toContain('a@b.com');
    expect(JSON.parse(body)).toMatchObject({
      schemaVersion: 'data-subject.erasure-evidence.v1',
      requestId: request.id,
      tenantId: 'tenant_1',
      actions: [
        {
          entityName: 'User',
          affected: 1,
          deleteFields: ['email'],
        },
      ],
    });
  });

  it('publishes audit events for request lifecycle transitions', async () => {
    const { service, auditEvents } = svc();

    const request = await service.export('subject_1', 'tenant_1');

    expect(auditEvents).toContainEqual({
      type: 'data_subject.request_created',
      payload: {
        requestId: request.id,
        type: 'export',
        tenantId: 'tenant_1',
      },
    });
    expect(auditEvents).toContainEqual({
      type: 'data_subject.request_processing',
      payload: {
        requestId: request.id,
        type: 'export',
        tenantId: 'tenant_1',
      },
    });
    expect(auditEvents).toContainEqual({
      type: 'data_subject.request_completed',
      payload: expect.objectContaining({
        requestId: request.id,
        type: 'export',
        tenantId: 'tenant_1',
      }),
    });
  });

  it('sets dueAt to createdAt + slaDays', async () => {
    const { service } = svc();

    const request = await service.export('subject_1', 'tenant_1');

    expect(request.dueAt.toISOString()).toBe('2026-01-31T00:00:00.000Z');
  });

  it('getRequest throws a typed error for missing ids', async () => {
    const { service } = svc();

    await expect(service.getRequest('missing', 'tenant_1')).rejects.toMatchObject({
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
        exportFields: ['email'],
      },
      executor: {
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
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
    expect(request.failureReason).toBe(DataSubjectErrorCode.VerificationFailed);
    expect(request.stats?.lifecycle).toMatchObject({
      dataOutcome: 'unknown',
      failureStage: 'data_execution',
      recovery: 'inspect_data',
    });
  });

  it('publishes request_failed for export errors', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
        exportFields: ['email'],
      },
      executor: {
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
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
    expect(request.failureReason).toBe('dsr_operation_failed');
    expect(outboxEvents).toContainEqual({
      type: 'data_subject.request_failed',
      payload: expect.objectContaining({
        requestId: request.id,
        failureReason: 'dsr_operation_failed',
      }),
    });
  });

  it('keeps committed erase completed when completion callback fails', async () => {
    const state = { rows: [{ id: 'u1', email: 'a@b.com' }] };
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        rowLevel: 'delete-row',
        fields: { email: 'delete' },
        exportFields: ['email'],
      },
      executor: {
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
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
    expect(request.state).toBe('completed');
    expect(request.failureReason).toBeNull();
    expect(request.failedAt).toBeNull();
    expect(request.stats?.lifecycle).toMatchObject({
      dataOutcome: 'completed',
      notificationFailures: [
        {
          channel: 'outbox',
          event: 'data_subject.request_completed',
          code: 'dsr_operation_failed',
          recovery: 'retry_notification',
        },
      ],
    });
    expect(state.rows).toEqual([]);
  });
});
