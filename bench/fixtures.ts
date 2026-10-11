import assert from 'node:assert/strict';
import { Decimal } from '@prisma/client/runtime/library';
import {
  DataSubjectService, Registry, InMemoryRequestStorage, InMemoryArtifactStorage,
  definePolicy, validateRegistry, type EntityDefinition, type EntityExecutor,
  type ErasePlan, type PolicySpec,
} from '../src';

export const SUBJECT = 'bench-subject';
export const TENANT = 'bench-tenant';
export const OTHER_TENANT = 'other-tenant';
export const BASE_DATE = '2020-01-01T00:00:00.000Z';
export const REPLACEMENT_DATE = '2000-02-29T00:00:00.123Z';
export const REPLACEMENT_UNITS = '9007199254740993';
export const REPLACEMENT_BALANCE = '9007199254740993.123456789';
export type Row = Record<string, unknown>;

function copyRow(row: Row): Row {
  // Object spread aliases Date and Decimal internals, hiding in-place mutations
  // from the original-data assertions and from the transaction rollback snapshot.
  return Object.fromEntries(Object.entries(row).map(([field, value]) => [
    field, value instanceof Date ? new Date(value.getTime())
      : Decimal.isDecimal(value) ? new Decimal(value) : value,
  ]));
}

const scalarFields = ['email', 'displayName', 'secret', 'amount', 'balance', 'happenedAt', 'units'];
const schema = (name: string) => `model ${name} {
  id Int @id
  subjectId String
  tenantId String
  email String?
  displayName String?
  secret String?
  amount Int
  balance Decimal?
  happenedAt DateTime?
  units BigInt?
}`;

export function definition(spec: PolicySpec): EntityDefinition {
  return definePolicy([{
    ...spec, stableIdField: 'id', scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    ignoredFields: Object.fromEntries(scalarFields.filter(field => !Object.hasOwn(spec.fields, field))
      .map(field => [field, 'Synthetic fixture value outside this scenario’s erase policy'])),
  }])[0];
}

export const deleteRow = definition({
  entityName: 'User', subjectField: 'subjectId', rowLevel: 'delete-row',
  fields: { email: 'delete', displayName: 'delete', secret: 'delete', happenedAt: 'delete', units: 'delete' },
});
export const deleteFields = definition({
  entityName: 'User', subjectField: 'subjectId', rowLevel: 'delete-fields',
  fields: { email: 'delete', displayName: 'delete', secret: 'delete' },
});
export const mixed = definition({
  entityName: 'User', subjectField: 'subjectId', rowLevel: 'delete-row',
  fields: {
    email: 'delete', secret: 'delete', displayName: { strategy: 'anonymize', replacement: '[REDACTED]' },
    amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
    balance: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
  },
});
export const scalarReplacement = definition({
  entityName: 'User', subjectField: 'subjectId',
  fields: {
    happenedAt: { strategy: 'anonymize', replacement: REPLACEMENT_DATE },
    units: { strategy: 'anonymize', replacement: REPLACEMENT_UNITS },
    balance: { strategy: 'anonymize', replacement: REPLACEMENT_BALANCE },
    amount: { strategy: 'retain', legalBasis: 'tax:KR-basic-law-sec85' },
  },
});

/** Synthetic scalar conversion only; this fixture does not emulate Prisma transactions. */
export class InMemoryExecutor implements EntityExecutor {
  readonly scope = { mode: 'multi-tenant' as const, tenantField: 'tenantId' };
  readonly identityField = 'id';
  rows: Row[];
  readonly original: Row[];

  constructor(count: number) {
    this.rows = Array.from({ length: count + 4 }, (_, index) => ({
      id: index + 1,
      subjectId: index < count + 2 ? SUBJECT : 'other-subject',
      tenantId: index >= count && index < count + 2 ? OTHER_TENANT : TENANT,
      email: `user${index}@example.test`, displayName: `User ${index}`, secret: `secret-${index}`,
      amount: 100 + index, balance: new Decimal(`100.${index + 1}`),
      happenedAt: new Date(BASE_DATE), units: 9007199254740993n + BigInt(index),
    }));
    this.original = this.rows.map(copyRow);
  }

  async select(subjectId: string, tenantId: string): Promise<Row[]> {
    return this.rows.filter(row => row.subjectId === subjectId && row.tenantId === tenantId).map(copyRow);
  }
  async selectByIds(ids: unknown[], tenantId: string): Promise<Row[]> {
    const keys = new Set(ids);
    return this.rows.filter(row => keys.has(row.id) && row.tenantId === tenantId).map(copyRow);
  }
  async erase(subjectId: string, tenantId: string, plan: ErasePlan): Promise<number> {
    const matches = (row: Row) => row.subjectId === subjectId && row.tenantId === tenantId;
    const selected = this.rows.filter(matches);
    if (plan.rowLevel === 'delete-row') this.rows = this.rows.filter(row => !matches(row));
    else for (const row of selected) for (const field of plan.deleteFields) row[field] = null;
    return selected.length;
  }
  async anonymize(subjectId: string, tenantId: string, replacements: Row): Promise<number> {
    const selected = this.rows.filter(row => row.subjectId === subjectId && row.tenantId === tenantId);
    for (const row of selected) for (const [field, value] of Object.entries(replacements)) {
      row[field] = value === null ? null
        : field === 'happenedAt' ? new Date(String(value))
          : field === 'balance' ? new Decimal(String(value))
            : field === 'units' ? BigInt(String(value)) : value;
    }
    return selected.length;
  }
  assertOtherScopesUnchanged(): void {
    const outside = (row: Row) => row.subjectId !== SUBJECT || row.tenantId !== TENANT;
    assert.deepEqual(this.rows.filter(outside), this.original.filter(outside));
  }
}

export function makeService(entities: Array<{ policy: EntityDefinition; executor: InMemoryExecutor }>) {
  const registry = new Registry();
  for (const entity of entities) registry.registerDefinition(entity.policy, entity.executor);
  const validation = validateRegistry(registry, { schemaSource: entities.map(entity => schema(entity.policy.entityName)).join('\n') });
  assert.equal(validation.ok, true, JSON.stringify(validation.findings));
  const requestStorage = new InMemoryRequestStorage();
  const artifactStorage = new InMemoryArtifactStorage();
  const service = new DataSubjectService({
    registry, requestStorage, artifactStorage, slaDays: 30,
    previewSigningKey: Buffer.alloc(32, 7), // Public synthetic benchmark key only.
    // Snapshot rollback is local fixture behavior, not PostgreSQL durability.
    runInTransaction: async work => {
      const before = entities.map(entity => entity.executor.rows.map(copyRow));
      try { return await work(); }
      catch (error) {
        entities.forEach((entity, index) => { entity.executor.rows = before[index]; });
        throw error;
      }
    },
  });
  return { service, requestStorage, artifactStorage };
}
