import type { EntityExecutor } from '../types';
import { DataSubjectError, DataSubjectErrorCode } from '../errors';

export interface PrismaDelegate {
  findMany(args: {
    where: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]>;
  deleteMany(args: {
    where: Record<string, unknown>;
  }): Promise<{ count: number }>;
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
}

export interface FromPrismaOptions {
  delegate: PrismaDelegate;
  subjectField: string;
  tenantField?: string;
  /** Explicit scope for databases which contain exactly one tenant. */
  singleTenantId?: string;
}

export function fromPrisma(opts: FromPrismaOptions): EntityExecutor {
  const { delegate, subjectField, tenantField, singleTenantId } = opts;
  const hasTenantField = tenantField !== undefined;
  const hasSingleTenantId = singleTenantId !== undefined;

  if (
    hasTenantField === hasSingleTenantId ||
    (hasTenantField && !isNonblank(tenantField)) ||
    (hasSingleTenantId && !isNonblank(singleTenantId)) ||
    !isNonblank(subjectField) ||
    subjectField === tenantField
  ) {
    throw new DataSubjectError(
      DataSubjectErrorCode.InvalidScope,
      'Provide a nonblank subjectField and exactly one of tenantField or singleTenantId; subjectField and tenantField must differ',
    );
  }

  const whereFor = (
    subjectId: string,
    tenantId: string,
  ): Record<string, unknown> => {
    if (!isNonblank(subjectId) || !isNonblank(tenantId)) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidInput,
        'subjectId and tenantId must be nonblank strings',
      );
    }
    if (hasSingleTenantId && tenantId !== singleTenantId) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidScope,
        'tenantId does not match the configured single-tenant scope',
      );
    }
    return tenantField
      ? { [subjectField]: subjectId, [tenantField]: tenantId }
      : { [subjectField]: subjectId };
  };

  return {
    scope: hasTenantField
      ? { mode: 'multi-tenant', tenantField: tenantField! }
      : { mode: 'single-tenant', tenantId: singleTenantId! },
    async select(subjectId, tenantId) {
      return delegate.findMany({ where: whereFor(subjectId, tenantId) });
    },
    async erase(subjectId, tenantId, plan) {
      const where = whereFor(subjectId, tenantId);
      if (plan.rowLevel === 'delete-row') {
        const result = await delegate.deleteMany({
          where,
        });
        return result.count;
      }

      const data = Object.fromEntries(
        plan.deleteFields.map((field) => [field, null]),
      );

      if (Object.keys(data).length === 0) {
        return 0;
      }

      const result = await delegate.updateMany({
        where,
        data,
      });
      return result.count;
    },
    async anonymize(subjectId, tenantId, replacements) {
      const result = await delegate.updateMany({
        where: whereFor(subjectId, tenantId),
        data: replacements,
      });
      return result.count;
    },
  };
}

function isNonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
