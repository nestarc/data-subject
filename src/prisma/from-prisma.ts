import type { EntityExecutor } from '../types';

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
}

export function fromPrisma(opts: FromPrismaOptions): EntityExecutor {
  const { delegate, subjectField, tenantField } = opts;

  const whereFor = (
    subjectId: string,
    tenantId: string,
  ): Record<string, unknown> => {
    const where: Record<string, unknown> = { [subjectField]: subjectId };
    if (tenantField) {
      where[tenantField] = tenantId;
    }
    return where;
  };

  return {
    async select(subjectId, tenantId) {
      return delegate.findMany({ where: whereFor(subjectId, tenantId) });
    },
    async erase(subjectId, tenantId, rowLevel) {
      if (rowLevel === 'delete-row') {
        const result = await delegate.deleteMany({
          where: whereFor(subjectId, tenantId),
        });
        return result.count;
      }

      const result = await delegate.updateMany({
        where: whereFor(subjectId, tenantId),
        data: {},
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
