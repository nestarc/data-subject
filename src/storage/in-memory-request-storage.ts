import type { DataSubjectRequest, RequestState } from '../types';
import type { RequestStorage } from './request-storage.interface';

const PENDING: RequestState[] = ['created', 'validating', 'processing'];

export class InMemoryRequestStorage implements RequestStorage {
  private readonly store = new Map<string, DataSubjectRequest>();

  async insert(req: DataSubjectRequest): Promise<void> {
    if (this.store.has(req.id)) {
      throw new Error(`duplicate id: ${req.id}`);
    }

    this.store.set(req.id, { ...req });
  }

  async update(id: string, patch: Partial<DataSubjectRequest>): Promise<void> {
    const request = this.store.get(id);
    if (!request) {
      throw new Error(`not found: ${id}`);
    }

    Object.assign(request, patch);
  }

  async findById(id: string): Promise<DataSubjectRequest | null> {
    const request = this.store.get(id);
    return request ? { ...request } : null;
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    return [...this.store.values()]
      .filter((request) => request.tenantId === tenantId)
      .filter((request) => (opts.state ? request.state === opts.state : true))
      .map((request) => ({ ...request }));
  }

  async listOverdue(now: Date): Promise<DataSubjectRequest[]> {
    return [...this.store.values()]
      .filter(
        (request) =>
          PENDING.includes(request.state) &&
          request.dueAt.getTime() < now.getTime(),
      )
      .map((request) => ({ ...request }));
  }
}
