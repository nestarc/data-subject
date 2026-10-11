import { DataSubjectErrorCode } from '../../src/errors';
import type { RequestStorage } from '../../src/storage/request-storage.interface';
import type { DataSubjectRequest } from '../../src/types';

function fixture(overrides: Partial<DataSubjectRequest> = {}): DataSubjectRequest {
  return {
    id: 'dsr_1',
    tenantId: 'tenant_1',
    subjectId: 'subject_1',
    type: 'export',
    state: 'created',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    dueAt: new Date('2026-01-31T00:00:00Z'),
    completedAt: null,
    failedAt: null,
    failureReason: null,
    artifactHash: null,
    artifactUrl: null,
    stats: null,
    requestedBy: null,
    ...overrides,
  };
}

export function requestStorageContract(
  name: string,
  factory: () => RequestStorage,
): void {
  describe(`RequestStorage contract: ${name}`, () => {
    let storage: RequestStorage;

    beforeEach(() => {
      storage = factory();
    });

    it('insert + findById round-trips', async () => {
      await storage.insert(fixture());

      const request = await storage.findById('dsr_1', 'tenant_1');
      expect(request?.state).toBe('created');
    });

    it('findById returns null for missing', async () => {
      expect(await storage.findById('missing', 'tenant_1')).toBeNull();
    });

    it('cannot read or update another tenant request with the same subject', async () => {
      await storage.insert(fixture());
      await storage.insert(fixture({ id: 'dsr_2', tenantId: 'tenant_2' }));

      expect(await storage.findById('dsr_1', 'tenant_2')).toBeNull();
      expect(await storage.findById('dsr_2', 'tenant_1')).toBeNull();
      await expect(
        storage.update('dsr_1', 'tenant_2', { state: 'completed' }),
      ).rejects.toMatchObject({ code: DataSubjectErrorCode.RequestNotFound });
      expect((await storage.findById('dsr_1', 'tenant_1'))?.state).toBe('created');
      expect((await storage.listByTenant('tenant_1')).map(({ id }) => id)).toEqual([
        'dsr_1',
      ]);
    });

    it('update patches fields', async () => {
      await storage.insert(fixture());
      await storage.update('dsr_1', 'tenant_1', { state: 'processing' });

      const request = await storage.findById('dsr_1', 'tenant_1');
      expect(request?.state).toBe('processing');
    });

    it('round-trips failure stage and recovery metadata', async () => {
      const stats = {
        entities: [],
        lifecycle: {
          dataOutcome: 'completed' as const,
          failureStage: 'artifact_write' as const,
          recovery: 'retry_artifact' as const,
          notificationFailures: [{
            channel: 'audit' as const,
            event: 'completed',
            code: 'delivery_failed',
            recovery: 'retry_notification' as const,
          }],
        },
      };
      await storage.insert(fixture({ stats }));
      expect((await storage.findById('dsr_1', 'tenant_1'))?.stats).toEqual(stats);
      await storage.update('dsr_1', 'tenant_1', { stats, failureReason: null });
      expect((await storage.findById('dsr_1', 'tenant_1'))?.stats).toEqual(stats);
    });

    it.each([
      { id: 'different' },
      { tenantId: 'tenant_2' },
      { subjectId: 'subject_2' },
      { type: 'erase' as const },
      { createdAt: new Date('2027-01-01T00:00:00Z') },
    ])('rejects immutable identity patches: %j', async (patch) => {
      await storage.insert(fixture());
      await expect(
        storage.update('dsr_1', 'tenant_1', patch),
      ).rejects.toMatchObject({ code: DataSubjectErrorCode.InvalidInput });
      expect(await storage.findById('dsr_1', 'tenant_1')).toEqual(fixture());
    });

    it('ignores undefined patches without removing tenant identity', async () => {
      await storage.insert(fixture());
      await storage.update('dsr_1', 'tenant_1', {
        tenantId: undefined,
        state: undefined,
      });
      expect(await storage.findById('dsr_1', 'tenant_1')).toEqual(fixture());
    });

    it.each(['', '  \t\n'])('rejects blank request and tenant identifiers: %j', async (blank) => {
      const invalidInput = { code: DataSubjectErrorCode.InvalidInput };
      await expect(storage.insert(fixture({ id: blank }))).rejects.toMatchObject(invalidInput);
      await expect(storage.insert(fixture({ tenantId: blank }))).rejects.toMatchObject(invalidInput);
      await expect(storage.insert(fixture({ subjectId: blank }))).rejects.toMatchObject(invalidInput);
      await expect(storage.findById(blank, 'tenant_1')).rejects.toMatchObject(invalidInput);
      await expect(storage.findById('dsr_1', blank)).rejects.toMatchObject(invalidInput);
      await expect(storage.update(blank, 'tenant_1', {})).rejects.toMatchObject(invalidInput);
      await expect(storage.update('dsr_1', blank, {})).rejects.toMatchObject(invalidInput);
      await expect(storage.listByTenant(blank)).rejects.toMatchObject(invalidInput);
    });

    it('does not share mutable date or stats references with callers', async () => {
      const request = fixture({ stats: { entities: [] } });
      await storage.insert(request);
      request.createdAt.setUTCFullYear(2040);
      request.stats!.entities.push({ entityName: 'changed', affected: 1, strategy: 'delete' });
      const loaded = (await storage.findById('dsr_1', 'tenant_1'))!;
      expect(loaded.createdAt).toEqual(fixture().createdAt);
      expect(loaded.stats).toEqual({ entities: [] });
      loaded.createdAt.setUTCFullYear(2041);
      loaded.stats!.entities.push({ entityName: 'changed', affected: 1, strategy: 'delete' });
      expect((await storage.findById('dsr_1', 'tenant_1'))?.createdAt).toEqual(fixture().createdAt);
      expect((await storage.findById('dsr_1', 'tenant_1'))?.stats).toEqual({ entities: [] });
    });

    it('listByTenant filters by state', async () => {
      await storage.insert(fixture({ id: 'a', state: 'created' }));
      await storage.insert(fixture({ id: 'b', state: 'completed' }));

      const completed = await storage.listByTenant('tenant_1', {
        state: 'completed',
      });

      expect(completed.map((request) => request.id)).toEqual(['b']);
    });

    it('listOverdue returns pending requests past dueAt', async () => {
      await storage.insert(
        fixture({
          id: 'a',
          dueAt: new Date('2025-12-01T00:00:00Z'),
          state: 'processing',
        }),
      );
      await storage.insert(
        fixture({
          id: 'b',
          dueAt: new Date('2027-01-01T00:00:00Z'),
          state: 'processing',
        }),
      );
      await storage.insert(
        fixture({
          id: 'c',
          dueAt: new Date('2025-12-01T00:00:00Z'),
          state: 'completed',
        }),
      );

      const overdue = await storage.listOverdue(
        new Date('2026-06-01T00:00:00Z'),
      );

      expect(overdue.map((request) => request.id)).toEqual(['a']);
    });

    it('insert rejects duplicate ids with a typed error', async () => {
      await storage.insert(fixture());

      await expect(storage.insert(fixture())).rejects.toMatchObject({
        code: DataSubjectErrorCode.RequestConflict,
      });
    });

    it('update rejects missing requests with a typed error', async () => {
      await expect(
        storage.update('missing', 'tenant_1', { state: 'failed' }),
      ).rejects.toMatchObject({
        code: DataSubjectErrorCode.RequestNotFound,
      });
    });
  });
}
