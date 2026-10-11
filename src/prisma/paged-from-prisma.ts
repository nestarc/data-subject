import { DataSubjectError, DataSubjectErrorCode } from '../errors';
import type { PagedEntityExecutor, PagedId, PagedReadInput } from '../jobs/paged-privacy';

export interface PagedPrismaDelegate {
  findMany(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, 'asc' | 'desc'>;
    take: number;
    select?: Record<string, boolean>;
  }): Promise<Record<string, unknown>[]>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface PagedFromPrismaOptions {
  delegate: PagedPrismaDelegate;
  subjectField: string;
  tenantField?: string;
  singleTenantId?: string;
  /** A unique immutable string or safe-integer Prisma scalar key. */
  stableIdField?: string;
}

const MAX_PAGE_SIZE = 1000;

/** Every read and write is bounded by a page or a finite set of stable row IDs. */
export function pagedFromPrisma(options: PagedFromPrismaOptions): PagedEntityExecutor {
  const { delegate, subjectField, tenantField, singleTenantId } = options;
  const identityField = options.stableIdField ?? 'id';
  const multiTenant = tenantField !== undefined;
  if (
    multiTenant === (singleTenantId !== undefined) ||
    !isFieldName(subjectField) || !isFieldName(identityField) ||
    (multiTenant && !isFieldName(tenantField)) ||
    (!multiTenant && !isNonblank(singleTenantId)) ||
    subjectField === tenantField || identityField === tenantField
  ) {
    throw new DataSubjectError(DataSubjectErrorCode.InvalidScope,
      'Configure scalar field names and exactly one of tenantField or singleTenantId');
  }

  const tenantWhere = (tenantId: string): Record<string, unknown> => {
    if (!isNonblank(tenantId)) invalidInput('tenantId must be a nonblank string');
    if (!multiTenant && tenantId !== singleTenantId) {
      throw new DataSubjectError(DataSubjectErrorCode.InvalidScope, 'Tenant does not match the configured single-tenant scope');
    }
    return multiTenant ? { [tenantField!]: tenantId } : {};
  };
  const subjectWhere = (subjectId: string, tenantId: string): Record<string, unknown> => {
    if (!isNonblank(subjectId)) invalidInput('subjectId must be a nonblank string');
    return { ...tenantWhere(tenantId), [subjectField]: subjectId };
  };
  const idWhere = (ids: PagedId[], tenantId: string): Record<string, unknown> => {
    validateIds(ids);
    return { ...tenantWhere(tenantId), [identityField]: { in: ids } };
  };
  const projection = (fields?: string[]): Record<string, boolean> | undefined => {
    if (fields === undefined) return undefined;
    if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isFieldName)) {
      invalidInput('Projection fields must be a nonempty list of scalar field names');
    }
    return Object.fromEntries(
      [...new Set([identityField, subjectField, ...(multiTenant ? [tenantField!] : []), ...fields])]
        .map(field => [field, true]),
    );
  };

  return {
    identityField,
    scope: multiTenant
      ? { mode: 'multi-tenant', tenantField: tenantField! }
      : { mode: 'single-tenant', tenantId: singleTenantId! },
    async highWatermark(input) {
      if (!isRecord(input)) invalidInput('A subject and tenant scope is required');
      const rows = await delegate.findMany({
        where: subjectWhere(input.subjectId, input.tenantId),
        orderBy: { [identityField]: 'desc' },
        take: 1,
        select: { [identityField]: true },
      });
      if (rows.length === 0) return null;
      const identity = rows[0][identityField];
      if (rows.length !== 1 || !isPagedId(identity)) invalidInput('The stable key must be a string or a safe integer');
      return identity;
    },
    async readPage(input: PagedReadInput) {
      if (!isRecord(input)) invalidInput('Page input is required');
      const where = subjectWhere(input.subjectId, input.tenantId);
      if (!isPagedId(input.through) ||
        (input.after !== undefined && (!isPagedId(input.after) || typeof input.after !== typeof input.through)) ||
        !Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
        invalidInput('A page requires consistent stable key types and a limit between 1 and 1000');
      }
      const select = projection(input.fields);
      // Keep the subject equality separate when its field is also the stable ID.
      // Prisma/database ordering, including string collation, governs both bounds.
      return delegate.findMany({
        where: {
          ...where,
          AND: [{ [identityField]: { ...(input.after === undefined ? {} : { gt: input.after }), lte: input.through } }],
        },
        orderBy: { [identityField]: 'asc' },
        take: input.limit,
        ...(select ? { select } : {}),
      });
    },
    async selectByIds(ids, tenantId, fields) {
      const where = idWhere(ids, tenantId);
      const select = projection(fields);
      return delegate.findMany({ where, take: ids.length, ...(select ? { select } : {}) });
    },
    async eraseByIds(ids, tenantId) {
      return (await delegate.deleteMany({ where: idWhere(ids, tenantId) })).count;
    },
    async updateByIds(ids, tenantId, replacements) {
      const where = idWhere(ids, tenantId);
      if (!isRecord(replacements) || Object.keys(replacements).length === 0 ||
        !Object.keys(replacements).every(isFieldName) || Object.values(replacements).some(value => value === undefined)) {
        invalidInput('Replacements must contain scalar fields and defined values');
      }
      if (Object.hasOwn(replacements, identityField) || (multiTenant && Object.hasOwn(replacements, tenantField!))) {
        throw new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'Stable identity and tenant fields must not be updated');
      }
      return (await delegate.updateMany({ where, data: replacements })).count;
    },
  };
}

function validateIds(ids: PagedId[]): void {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PAGE_SIZE ||
    !ids.every(isPagedId) || ids.some(id => typeof id !== typeof ids[0]) || new Set(ids).size !== ids.length) {
    invalidInput('Stable IDs must be 1 to 1000 unique nonblank strings or safe integers of one type');
  }
}

function isPagedId(value: unknown): value is PagedId {
  return isNonblank(value) || (typeof value === 'number' && Number.isSafeInteger(value));
}

function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFieldName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidInput(message: string): never {
  throw new DataSubjectError(DataSubjectErrorCode.InvalidInput, message);
}
