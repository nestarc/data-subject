import { definePolicy, type EntityDefinition } from './policy-definition';
import { Registry } from './registry';
import { lintPrismaSchema } from './lint';
import type { EntityExecutor } from './types';

const definition: EntityDefinition = {
  entityName: 'User',
  subjectField: 'subjectId',
  stableIdField: 'id',
  scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
  fields: { email: 'delete' },
  ignoredFields: { createdAt: 'operational timestamp' },
  exportFields: ['email'],
};
const executor: EntityExecutor = {
  scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
  select: async () => [],
  erase: async () => 0,
  anonymize: async () => 0,
};

describe('shared policy definitions', () => {
  it('uses one serializable definition for runtime registration and strict schema lint', () => {
    const definitions = definePolicy([definition]);
    const registry = new Registry();
    registry.registerDefinition(definitions[0], executor);
    const schema = `model User {
      id String @id
      subjectId String
      tenantId String
      email String?
      createdAt DateTime
    }`;
    expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });
    definitions[0].fields.email = { strategy: 'anonymize', replacement: 'changed' };
    expect(registry.get('User')?.policy.fields.email).toEqual({ strategy: 'delete' });
    expect(registry.definitions()[0].fields.email).toBe('delete');
  });

  it('rejects mismatched executor tenant scope', () => {
    expect(() =>
      new Registry().registerDefinition(definition, {
        ...executor,
        scope: { mode: 'single-tenant', tenantId: 't1' },
      }),
    ).toThrow(/scope differs/);
  });

  it.each([undefined, () => 'dynamic', new Date(), Number.NaN])(
    'rejects non-JSON definitions (%p)',
    (bad) => {
      expect(() =>
        definePolicy([{ ...definition, ignoredFields: { createdAt: bad as unknown as string } }]),
      ).toThrow();
    },
  );

  it('rejects cycles and reasonless or overlapping exclusions', () => {
    const cyclic = { ...definition } as EntityDefinition & { cycle?: unknown };
    cyclic.cycle = cyclic;
    expect(() => definePolicy([cyclic])).toThrow(/JSON/);
    expect(() => definePolicy([{ ...definition, ignoredFields: { createdAt: ' ' } }])).toThrow(
      /reason/,
    );
    expect(() => definePolicy([{ ...definition, ignoredFields: { email: 'overlap' } }])).toThrow(
      /also/,
    );
  });

  it('rejects duplicate definitions', () => {
    expect(() => definePolicy([definition, definition])).toThrow(/Duplicate/);
  });
});
