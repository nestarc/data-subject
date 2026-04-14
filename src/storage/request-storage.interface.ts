import type { DataSubjectRequest, RequestState } from '../types';

export interface RequestStorage {
  insert(req: DataSubjectRequest): Promise<void>;
  update(id: string, patch: Partial<DataSubjectRequest>): Promise<void>;
  findById(id: string): Promise<DataSubjectRequest | null>;
  listByTenant(
    tenantId: string,
    opts?: { state?: RequestState },
  ): Promise<DataSubjectRequest[]>;
  listOverdue(now: Date): Promise<DataSubjectRequest[]>;
}
