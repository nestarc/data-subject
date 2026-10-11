import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type { DataSubjectRequest, RequestState, RequestStats } from '../types';
import type { RequestStorage } from './request-storage.interface';
import {
  validateRequestIdentifier,
  validateRequestIdentity,
  validateRequestPatch,
} from './request-storage-validation';

const PENDING: RequestState[] = ['created', 'validating', 'processing'];

export interface PrismaDataSubjectRequestDelegate {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  update(args: {
    where: { id: string; tenantId: string };
    data: Record<string, unknown>;
  }): Promise<unknown>;
  findUnique(args: {
    where: { id: string; tenantId: string };
  }): Promise<unknown | null>;
  findMany(args: {
    where?: {
      tenantId?: string;
      state?: RequestState | { in: RequestState[] };
      dueAt?: { lt: Date };
    };
    orderBy?: { createdAt?: 'asc' | 'desc'; dueAt?: 'asc' | 'desc' };
  }): Promise<unknown[]>;
}

export interface PrismaRequestStorageOptions {
  delegate: PrismaDataSubjectRequestDelegate;
}

export class PrismaRequestStorage implements RequestStorage {
  constructor(private readonly opts: PrismaRequestStorageOptions) {}

  async insert(req: DataSubjectRequest): Promise<void> {
    validateRequestIdentity(req);
    try {
      await this.opts.delegate.create({ data: serializeRequest(req) });
    } catch (error) {
      if (hasPrismaCode(error, 'P2002')) {
        throw new DataSubjectError(
          DataSubjectErrorCode.RequestConflict,
          `duplicate id: ${req.id}`,
        );
      }
      throw error;
    }
  }

  async update(
    id: string,
    tenantId: string,
    patch: Partial<DataSubjectRequest>,
  ): Promise<void> {
    validateRequestIdentifier(id, 'id');
    validateRequestIdentifier(tenantId, 'tenantId');
    validateRequestPatch(patch);
    try {
      await this.opts.delegate.update({
        where: { id, tenantId },
        data: serializePatch(patch),
      });
    } catch (error) {
      if (hasPrismaCode(error, 'P2025')) {
        throw new DataSubjectError(
          DataSubjectErrorCode.RequestNotFound,
          `request ${id} not found`,
        );
      }
      throw error;
    }
  }

  async findById(id: string, tenantId: string): Promise<DataSubjectRequest | null> {
    validateRequestIdentifier(id, 'id');
    validateRequestIdentifier(tenantId, 'tenantId');
    const row = await this.opts.delegate.findUnique({ where: { id, tenantId } });
    return row ? deserializeRequest(row) : null;
  }

  async listByTenant(
    tenantId: string,
    opts: { state?: RequestState } = {},
  ): Promise<DataSubjectRequest[]> {
    validateRequestIdentifier(tenantId, 'tenantId');
    const rows = await this.opts.delegate.findMany({
      where: {
        tenantId,
        ...(opts.state ? { state: opts.state } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(deserializeRequest);
  }

  async listOverdue(now: Date): Promise<DataSubjectRequest[]> {
    const rows = await this.opts.delegate.findMany({
      where: {
        state: { in: PENDING },
        dueAt: { lt: now },
      },
      orderBy: { dueAt: 'asc' },
    });
    return rows.map(deserializeRequest);
  }
}

function serializeRequest(req: DataSubjectRequest): Record<string, unknown> {
  return {
    id: req.id,
    tenantId: req.tenantId,
    subjectId: req.subjectId,
    type: req.type,
    state: req.state,
    createdAt: req.createdAt,
    dueAt: req.dueAt,
    completedAt: req.completedAt,
    failedAt: req.failedAt,
    failureReason: req.failureReason,
    artifactHash: req.artifactHash,
    artifactUrl: req.artifactUrl,
    stats: req.stats,
    requestedBy: req.requestedBy,
  };
}

function serializePatch(
  patch: Partial<DataSubjectRequest>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      data[key] = value;
    }
  }
  return data;
}

function deserializeRequest(row: unknown): DataSubjectRequest {
  const raw = row as Record<string, unknown>;
  return {
    id: stringValue(raw.id),
    tenantId: stringValue(raw.tenantId),
    subjectId: stringValue(raw.subjectId),
    type: requestTypeValue(raw.type),
    state: requestStateValue(raw.state),
    createdAt: dateValue(raw.createdAt),
    dueAt: dateValue(raw.dueAt),
    completedAt: nullableDateValue(raw.completedAt),
    failedAt: nullableDateValue(raw.failedAt),
    failureReason: nullableStringValue(raw.failureReason),
    artifactHash: nullableStringValue(raw.artifactHash),
    artifactUrl: nullableStringValue(raw.artifactUrl),
    stats: (raw.stats ?? null) as RequestStats | null,
    requestedBy: nullableStringValue(raw.requestedBy),
  };
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('expected string field in DataSubjectRequest row');
  }
  return value;
}

function nullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return stringValue(value);
}

function dateValue(value: unknown): Date {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'string') {
    return new Date(value);
  }
  throw new TypeError('expected date field in DataSubjectRequest row');
}

function nullableDateValue(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  return dateValue(value);
}

function requestTypeValue(value: unknown): DataSubjectRequest['type'] {
  if (value === 'export' || value === 'erase') {
    return value;
  }
  throw new TypeError('expected request type field in DataSubjectRequest row');
}

function requestStateValue(value: unknown): DataSubjectRequest['state'] {
  if (
    value === 'created' ||
    value === 'validating' ||
    value === 'processing' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  throw new TypeError('expected request state field in DataSubjectRequest row');
}

function hasPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}
