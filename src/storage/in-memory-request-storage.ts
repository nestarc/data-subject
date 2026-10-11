import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type { DataSubjectRequest, RequestState } from '../types';
import type { RequestStorage } from './request-storage.interface';
import {
  validateRequestIdentifier,
  validateRequestIdentity,
  validateRequestPatch,
} from './request-storage-validation';

const PENDING: RequestState[] = ['created', 'validating', 'processing'];

export class InMemoryRequestStorage implements RequestStorage {
  private readonly store = new Map<string, DataSubjectRequest>();

  async insert(req: DataSubjectRequest): Promise<void> {
    validateRequestIdentity(req);
    if (this.store.has(req.id)) {
      throw new DataSubjectError(
        DataSubjectErrorCode.RequestConflict,
        `duplicate id: ${req.id}`,
      );
    }

    this.store.set(req.id, structuredClone(req));
  }

  async update(
    id: string,
    tenantId: string,
    patch: Partial<DataSubjectRequest>,
  ): Promise<void> {
    validateRequestIdentifier(id, 'id');
    validateRequestIdentifier(tenantId, 'tenantId');
    validateRequestPatch(patch);
    const request = this.store.get(id);
    if (!request || request.tenantId !== tenantId) {
      throw new DataSubjectError(
        DataSubjectErrorCode.RequestNotFound,
        `request ${id} not found`,
      );
    }

    for (const [field, value] of Object.entries(patch)) {
      if (value !== undefined) {
        Object.assign(request, { [field]: structuredClone(value) });
      }
    }
  }

  async findById(id: string, tenantId: string): Promise<DataSubjectRequest | null> {
    validateRequestIdentifier(id, 'id');
    validateRequestIdentifier(tenantId, 'tenantId');
    const request = this.store.get(id);
    return request?.tenantId === tenantId ? structuredClone(request) : null;
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    validateRequestIdentifier(tenantId, 'tenantId');
    return [...this.store.values()]
      .filter((request) => request.tenantId === tenantId)
      .filter((request) => (opts.state ? request.state === opts.state : true))
      .map((request) => structuredClone(request));
  }

  async listOverdue(now: Date): Promise<DataSubjectRequest[]> {
    return [...this.store.values()]
      .filter(
        (request) =>
          PENDING.includes(request.state) &&
          request.dueAt.getTime() < now.getTime(),
      )
      .map((request) => structuredClone(request));
  }
}
