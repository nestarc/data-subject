import { PrismaRequestStorage } from '../../src/storage/prisma-request-storage';
import type { PrismaDataSubjectRequestDelegate } from '../../src/storage/prisma-request-storage';
import { requestStorageContract } from '../contract/request-storage-contract';

class FakePrismaRequestDelegate implements PrismaDataSubjectRequestDelegate {
  private readonly rows = new Map<string, Record<string, unknown>>();

  async create(args: { data: Record<string, unknown> }): Promise<unknown> {
    const id = String(args.data.id);
    if (this.rows.has(id)) {
      throw { code: 'P2002' };
    }
    const row = clone(args.data);
    this.rows.set(id, row);
    return clone(row);
  }

  async update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<unknown> {
    const row = this.rows.get(args.where.id);
    if (!row) {
      throw { code: 'P2025' };
    }
    Object.assign(row, args.data);
    return clone(row);
  }

  async findUnique(args: {
    where: { id: string };
  }): Promise<unknown | null> {
    const row = this.rows.get(args.where.id);
    return row ? clone(row) : null;
  }

  async findMany(args: Record<string, unknown>): Promise<unknown[]> {
    const where = (args.where ?? {}) as Record<string, unknown>;
    return [...this.rows.values()]
      .filter((row) => matchesWhere(row, where))
      .map((row) => clone(row));
  }
}

requestStorageContract(
  'PrismaRequestStorage',
  () =>
    new PrismaRequestStorage({
      delegate: new FakePrismaRequestDelegate(),
    }),
);

function matchesWhere(
  row: Record<string, unknown>,
  where: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(where)) {
    if (isObject(expected) && 'in' in expected) {
      const values = expected.in as unknown[];
      if (!values.includes(row[key])) {
        return false;
      }
      continue;
    }

    if (isObject(expected) && 'lt' in expected) {
      const value = row[key];
      if (!(value instanceof Date) || !(expected.lt instanceof Date)) {
        return false;
      }
      if (value.getTime() >= expected.lt.getTime()) {
        return false;
      }
      continue;
    }

    if (row[key] !== expected) {
      return false;
    }
  }
  return true;
}

function clone(row: Record<string, unknown>): Record<string, unknown> {
  return { ...row };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
