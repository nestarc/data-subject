import type { DataSubjectRequest, RequestState } from '../types';

export interface RequestStorage {
  insert(req: DataSubjectRequest): Promise<void>;
  /** Update within a tenant; request identity fields are immutable. */
  update(
    id: string,
    tenantId: string,
    patch: Partial<DataSubjectRequest>,
  ): Promise<void>;
  /** A request outside the supplied tenant is indistinguishable from a missing request. */
  findById(id: string, tenantId: string): Promise<DataSubjectRequest | null>;
  listByTenant(
    tenantId: string,
    opts?: { state?: RequestState },
  ): Promise<DataSubjectRequest[]>;
  listOverdue(now: Date): Promise<DataSubjectRequest[]>;
}
