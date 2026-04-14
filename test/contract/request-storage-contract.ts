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

      const request = await storage.findById('dsr_1');
      expect(request?.state).toBe('created');
    });

    it('findById returns null for missing', async () => {
      expect(await storage.findById('missing')).toBeNull();
    });

    it('update patches fields', async () => {
      await storage.insert(fixture());
      await storage.update('dsr_1', { state: 'processing' });

      const request = await storage.findById('dsr_1');
      expect(request?.state).toBe('processing');
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
  });
}
