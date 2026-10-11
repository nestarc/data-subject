import { DataSubjectService, type DataSubjectServiceDeps } from '../../src/data-subject.service';
import { DataSubjectErrorCode } from '../../src/errors';
import { fromPrisma } from '../../src/prisma/from-prisma';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import { InMemoryRequestStorage } from '../../src/storage/in-memory-request-storage';
import type { EntityExecutor } from '../../src/types';

function setup(
  overrides: Partial<DataSubjectServiceDeps> = {},
  executorOverrides: Partial<EntityExecutor> = {},
) {
  const rows = [{ tenantId: 't1', subjectId: 's1', email: 'secret@example.com' }];
  const executor: EntityExecutor = {
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    select: jest.fn(async () => rows.map((row) => ({ ...row }))),
    erase: jest.fn(async () => {
      const count = rows.length;
      rows.splice(0);
      return count;
    }),
    anonymize: jest.fn(async () => 0),
    ...executorOverrides,
  };
  const registry = new Registry();
  registry.register({
    policy: {
      entityName: 'User',
      subjectField: 'subjectId',
      rowLevel: 'delete-row',
      fields: { email: 'delete' },
      exportFields: ['email'],
    },
    executor,
  });
  const storage = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const deps: DataSubjectServiceDeps = {
    registry,
    requestStorage: storage,
    artifactStorage: artifacts,
    slaDays: 30,
    idFactory: () => 'request-1',
    ...overrides,
  };
  return { service: new DataSubjectService(deps), rows, storage, artifacts, executor, deps };
}

describe('P0 lifecycle boundaries', () => {
  it.each(['outbox', 'audit'] as const)(
    'records request-created %s failure without executing data',
    async (channel) => {
      const hook = jest.fn(async (event: string) => {
        if (event === 'data_subject.request_created') throw new Error('password=secret');
      });
      const { service, executor } = setup(
        channel === 'outbox' ? { publishOutbox: hook } : { publishAudit: hook },
      );
      const result = await service.erase('s1', 't1');
      expect(result).toMatchObject({
        state: 'failed',
        completedAt: null,
        failureReason: 'dsr_operation_failed',
        stats: {
          lifecycle: {
            dataOutcome: 'not_started',
            failureStage: 'request_created',
            recovery: 'retry_request',
          },
        },
      });
      expect(executor.select).not.toHaveBeenCalled();
      expect(executor.erase).not.toHaveBeenCalled();
      expect(hook).toHaveBeenCalledWith('data_subject.request_failed', expect.anything());
      expect(JSON.stringify(result)).not.toContain('secret');
    },
  );

  it('records processing audit failure before any row access', async () => {
    const { service, executor } = setup({
      publishAudit: async (event) => {
        if (event === 'data_subject.request_processing') throw new Error('fail');
      },
    });
    const result = await service.erase('s1', 't1');
    expect(result.stats?.lifecycle).toMatchObject({
      dataOutcome: 'not_started',
      failureStage: 'processing',
      recovery: 'retry_request',
    });
    expect(executor.select).not.toHaveBeenCalled();
  });

  it('records potentially partial data failures without inventing a rollback', async () => {
    const { service } = setup(
      {},
      {
        erase: async () => {
          throw new Error('db contains secret@example.com');
        },
      },
    );
    const result = await service.erase('s1', 't1');
    expect(result.stats?.lifecycle).toMatchObject({
      dataOutcome: 'unknown',
      failureStage: 'data_execution',
      recovery: 'inspect_data',
    });
    expect(result.failureReason).toBe('dsr_operation_failed');
  });

  it('allows a real transaction wrapper to roll back an execution failure', async () => {
    let rows = [{ id: 1 }];
    let selects = 0;
    const { service } = setup(
      {
        runInTransaction: async (work) => {
          const before = [...rows];
          try {
            return await work();
          } catch (error) {
            rows = before;
            throw error;
          }
        },
      },
      {
        select: async () => {
          if (++selects > 1) throw new Error('verification read failed');
          return [...rows];
        },
        erase: async () => {
          rows = [];
          return 1;
        },
      },
    );
    const result = await service.erase('s1', 't1');
    expect(result.state).toBe('failed');
    expect(rows).toEqual([{ id: 1 }]);
    expect(result.stats?.lifecycle?.failureStage).toBe('data_execution');
  });

  it('uploads evidence only after commit and preserves committed outcome on upload failure', async () => {
    let committed = false;
    const { service, rows } = setup({
      runInTransaction: async (work) => {
        const result = await work();
        committed = true;
        return result;
      },
      artifactStorage: {
        get: async () => null,
        put: async () => {
          expect(committed).toBe(true);
          throw new Error('provider token=secret');
        },
      },
    });
    const result = await service.erase('s1', 't1');
    expect(rows).toEqual([]);
    expect(result).toMatchObject({
      state: 'failed',
      completedAt: null,
      artifactUrl: null,
      stats: {
        entities: [{ affected: 1 }],
        lifecycle: {
          dataOutcome: 'completed',
          failureStage: 'artifact_write',
          recovery: 'retry_artifact',
        },
      },
    });
  });

  it('distinguishes export upload failure from query failure', async () => {
    const { service } = setup({
      artifactStorage: {
        get: async () => null,
        put: async () => {
          throw new Error('down');
        },
      },
    });
    const result = await service.export('s1', 't1');
    expect(result.stats?.lifecycle).toMatchObject({
      dataOutcome: 'completed',
      failureStage: 'artifact_write',
    });
  });

  it('leaves a durable unknown checkpoint when storage goes down after commit', async () => {
    const { deps, storage, rows } = setup();
    const update = storage.update.bind(storage);
    storage.update = jest.fn(async (id, tenantId, patch) => {
      if (rows.length === 0) throw new Error('storage offline');
      await update(id, tenantId, patch);
    });
    await expect(new DataSubjectService(deps).erase('s1', 't1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.RequestPersistenceFailed,
      requestId: 'request-1',
      tenantId: 't1',
      dataOutcome: 'completed',
      recovery: 'reconcile_request',
    });
    expect(rows).toEqual([]);
    expect((await storage.findById('request-1', 't1'))?.stats?.lifecycle?.dataOutcome).toBe(
      'unknown',
    );
  });

  it('preserves completed data outcome when evidence preparation fails after commit', async () => {
    let calls = 0;
    const { service, rows } = setup({
      clock: () => (++calls === 3 ? new Date('invalid') : new Date()),
    });
    const result = await service.erase('s1', 't1');
    expect(rows).toEqual([]);
    expect(result.stats?.lifecycle).toMatchObject({
      dataOutcome: 'completed',
      failureStage: 'artifact_write',
    });
  });

  it('does not retry erase after completion persistence failure', async () => {
    const { deps, storage, rows, executor } = setup();
    const update = storage.update.bind(storage);
    storage.update = jest.fn(async (id, tenantId, patch) => {
      if (patch.state === 'completed') throw new Error('state write failed');
      await update(id, tenantId, patch);
    });
    const result = await new DataSubjectService(deps).erase('s1', 't1');
    expect(rows).toEqual([]);
    expect(executor.erase).toHaveBeenCalledTimes(1);
    expect(result.stats?.lifecycle).toMatchObject({
      dataOutcome: 'completed',
      failureStage: 'completion_persistence',
      recovery: 'reconcile_request',
    });
    expect(result.artifactUrl).not.toBeNull();
  });

  it.each(['export', 'erase'] as const)(
    'keeps %s completed and tries both terminal channels independently',
    async (type) => {
      const outbox = jest.fn(async (event: string) => {
        if (event.endsWith('completed')) throw new Error('token=secret');
      });
      const audit = jest.fn(async (event: string) => {
        if (event.endsWith('completed')) throw new Error('user@example.com');
      });
      const { service } = setup({ publishOutbox: outbox, publishAudit: audit });
      const result = await service[type]('s1', 't1');
      expect(result).toMatchObject({ state: 'completed', failedAt: null, failureReason: null });
      expect(Number.isFinite(result.completedAt?.getTime())).toBe(true);
      expect(result.stats?.lifecycle?.notificationFailures).toEqual([
        {
          channel: 'outbox',
          event: 'data_subject.request_completed',
          code: 'dsr_operation_failed',
          recovery: 'retry_notification',
        },
        {
          channel: 'audit',
          event: 'data_subject.request_completed',
          code: 'dsr_operation_failed',
          recovery: 'retry_notification',
        },
      ]);
      expect(JSON.stringify(result.stats)).not.toMatch(/secret|user@example/);
      expect(outbox).not.toHaveBeenCalledWith('data_subject.request_failed', expect.anything());
    },
  );

  it('returns a sanitized reconciliation error with the request ID when notification recording fails', async () => {
    const { deps, storage } = setup({
      publishOutbox: async (event) => {
        if (event.endsWith('completed')) throw new Error('callback token=secret');
      },
    });
    const update = storage.update.bind(storage);
    storage.update = async (id, tenantId, patch) => {
      if (patch.stats?.lifecycle?.notificationFailures) throw new Error('database password=secret');
      await update(id, tenantId, patch);
    };
    await expect(new DataSubjectService(deps).erase('s1', 't1')).rejects.toMatchObject({
      code: DataSubjectErrorCode.RequestPersistenceFailed,
      requestId: 'request-1',
      tenantId: 't1',
      dataOutcome: 'completed',
      recovery: 'reconcile_request',
      message: 'dsr_request_persistence_failed',
    });
    expect((await storage.findById('request-1', 't1'))?.state).toBe('completed');
  });

  it('preserves primary failure if both failure notifications also fail', async () => {
    const hook = async () => {
      throw new Error('delivery failed');
    };
    const { service } = setup({ publishOutbox: hook, publishAudit: hook });
    const result = await service.erase('s1', 't1');
    expect(result.stats?.lifecycle?.failureStage).toBe('request_created');
    expect(result.stats?.lifecycle?.notificationFailures).toHaveLength(2);
  });
});

describe('P0 service scope', () => {
  it.each(['', ' ', '\n', '\ud800'])(
    'rejects blank input %j before inserting or selecting',
    async (blank) => {
      const { service, storage, executor } = setup();
      const insert = jest.spyOn(storage, 'insert');
      for (const args of [
        [blank, 't1'],
        ['s1', blank],
      ]) {
        await expect(service.export(args[0], args[1])).rejects.toMatchObject({
          code: DataSubjectErrorCode.InvalidInput,
        });
        await expect(service.erase(args[0], args[1])).rejects.toMatchObject({
          code: DataSubjectErrorCode.InvalidInput,
        });
      }
      expect(insert).not.toHaveBeenCalled();
      expect(executor.select).not.toHaveBeenCalled();
    },
  );

  it('rejects missing executor scope and single-tenant executor in default mode', async () => {
    for (const scope of [undefined, { mode: 'single-tenant' as const, tenantId: 't1' }]) {
      const { service, storage, executor } = setup({}, { scope });
      const insert = jest.spyOn(storage, 'insert');
      await expect(service.erase('s1', 't1')).rejects.toMatchObject({
        code: DataSubjectErrorCode.InvalidScope,
      });
      expect(insert).not.toHaveBeenCalled();
      expect(executor.select).not.toHaveBeenCalled();
    }
  });

  it('supports explicit single-tenant mode and rejects a different tenant', async () => {
    const { service } = setup(
      { singleTenantId: 't1' },
      { scope: { mode: 'single-tenant', tenantId: 't1' } },
    );
    expect((await service.export('s1', 't1', { requestedBy: 'operator' })).requestedBy).toBe(
      'operator',
    );
    await expect(service.getRequest('request-1', 't2')).rejects.toMatchObject({
      code: DataSubjectErrorCode.InvalidScope,
    });
    await expect(service.erase('s1', 't2')).rejects.toMatchObject({
      code: DataSubjectErrorCode.InvalidScope,
    });
  });

  it('isolates data, request lookup and artifact reads for an identical subject in two tenants', async () => {
    const rows = [
      {
        subjectId: 'same',
        tenantId: 't1',
        email: 'first@example.com',
        passwordHash: 'never-export',
      },
      {
        subjectId: 'same',
        tenantId: 't2',
        email: 'second@example.com',
        passwordHash: 'never-export',
      },
    ];
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, value]) => row[key] === value);
    const executor = fromPrisma({
      subjectField: 'subjectId',
      tenantField: 'tenantId',
      delegate: {
        findMany: async ({ where }) => rows.filter((row) => matches(row, where)),
        deleteMany: async ({ where }) => {
          const found = rows.filter((row) => matches(row, where));
          for (const row of found) rows.splice(rows.indexOf(row), 1);
          return { count: found.length };
        },
        updateMany: async () => ({ count: 0 }),
      },
    });
    const { service, artifacts } = setup({}, executor);
    const get = jest.spyOn(artifacts, 'get');
    const result = await service.export('same', 't1');
    await expect(service.getRequest(result.id, 't2')).rejects.toMatchObject({
      code: DataSubjectErrorCode.RequestNotFound,
    });
    await expect(service.getArtifact(result.id, 't2')).rejects.toMatchObject({
      code: DataSubjectErrorCode.RequestNotFound,
    });
    expect(get).not.toHaveBeenCalled();
    expect(await service.getArtifact(result.id, 't1')).not.toBeNull();
    // A separate request ID lets the same service perform the subsequent erase.
    const { service: eraser } = setup({}, executor);
    await eraser.erase('same', 't1');
    expect(rows).toEqual([
      {
        subjectId: 'same',
        tenantId: 't2',
        email: 'second@example.com',
        passwordHash: 'never-export',
      },
    ]);
  });
});
