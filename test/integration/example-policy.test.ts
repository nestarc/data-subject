import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DataSubjectErrorCode,
  Registry,
  lintPrismaSchema,
  validateRegistry,
  type PrismaDelegate,
} from '../../src';
import {
  singleTenantUserDefinitions,
  singleTenantUserEntity,
  tenantUserDefinitions,
  tenantUserEntity,
} from '../../examples/tenant-safe/policy';

const tenantSchema = readFileSync(
  resolve(__dirname, '../../examples/tenant-safe/schema.example.prisma'),
  'utf8',
);
const singleTenantSchema = tenantSchema.replace(/^\s*tenantId\s+String\s*$/m, '');
const tenantId = 'installation-a';

function mockDelegate(): jest.Mocked<PrismaDelegate> {
  return {
    findMany: jest.fn().mockResolvedValue([]),
    deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
}

const variants = [
  {
    label: 'multi-tenant',
    schema: tenantSchema,
    definitions: tenantUserDefinitions,
    entity: tenantUserEntity,
    subjectWhere: { userId: 'subject-a', tenantId },
    identityWhere: { id: { in: ['row-a'] }, tenantId },
  },
  {
    label: 'single-tenant',
    schema: singleTenantSchema,
    definitions: singleTenantUserDefinitions(tenantId),
    entity: (delegate: PrismaDelegate) => singleTenantUserEntity(delegate, tenantId),
    subjectWhere: { userId: 'subject-a' },
    identityWhere: { id: { in: ['row-a'] } },
  },
];

describe.each(variants)('tenant-safe $label policy example', (variant) => {
  it('shares complete schema coverage between lint and runtime registration', () => {
    const entity = variant.entity(mockDelegate());
    expect([entity.definition]).toEqual(variant.definitions);
    expect(
      lintPrismaSchema(variant.schema, {
        definitions: variant.definitions,
        strictCoverage: true,
      }),
    ).toEqual({ ok: true, findings: [] });

    const registry = new Registry();
    registry.registerDefinition(entity.definition, entity.executor);
    expect(registry.definitions()).toEqual(variant.definitions);
    expect(validateRegistry(registry, { schemaSource: variant.schema })).toEqual({
      ok: true,
      findings: [],
    });
    expect(registry.get('User')?.policy).toMatchObject({
      stableIdField: 'id',
      rowLevel: 'delete-fields',
      exportFields: ['email', 'displayName'],
      fields: {
        email: { strategy: 'delete' },
        displayName: { strategy: 'delete' },
        passwordHash: { strategy: 'delete' },
        sessionToken: { strategy: 'delete' },
      },
    });
  });

  it('rejects a new scalar even when its name does not look like personal data', () => {
    const schema = variant.schema.replace('model User {', 'model User {\n  opaqueValue String?');
    const report = lintPrismaSchema(schema, { definitions: variant.definitions });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'dsr_lint_missing_policy_field',
        model: 'User',
        field: 'opaqueValue',
        severity: 'error',
      }),
    );
  });

  it.each(['email', 'displayName', 'passwordHash', 'sessionToken'])(
    'rejects making the deleted %s field required',
    (field) => {
      const schema = variant.schema.replace(new RegExp(`(${field}\\s+String)\\?`), '$1');
      const report = lintPrismaSchema(schema, { definitions: variant.definitions });
      expect(report.ok).toBe(false);
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          code: 'dsr_lint_nonnullable_write',
          model: 'User',
          field,
          severity: 'error',
        }),
      );
    },
  );

  it('uses the definition scope and stable identity in the generated Prisma executor', async () => {
    const delegate = mockDelegate();
    const { definition, executor } = variant.entity(delegate);
    const registry = new Registry();
    registry.registerDefinition(definition, executor);
    const registered = registry.get('User')!;
    expect(registered.executor.scope).toEqual(definition.scope);
    expect(registered.executor.identityField).toBe(definition.stableIdField);

    await registered.executor.select('subject-a', tenantId);
    expect(delegate.findMany).toHaveBeenLastCalledWith({ where: variant.subjectWhere });
    await registered.executor.selectByIds!(['row-a'], tenantId);
    expect(delegate.findMany).toHaveBeenLastCalledWith({ where: variant.identityWhere });
    await registered.executor.erase('subject-a', tenantId, {
      rowLevel: registered.policy.rowLevel,
      deleteFields: Object.keys(registered.policy.fields),
    });
    expect(delegate.updateMany).toHaveBeenLastCalledWith({
      where: variant.subjectWhere,
      data: { email: null, displayName: null, passwordHash: null, sessionToken: null },
    });
    expect(delegate.deleteMany).not.toHaveBeenCalled();
  });
});

it('rejects another installation before any single-tenant delegate operation', async () => {
  const delegate = mockDelegate();
  const { executor } = singleTenantUserEntity(delegate, tenantId);
  const invalidScope = { code: DataSubjectErrorCode.InvalidScope };
  await expect(executor.select('subject-a', 'installation-b')).rejects.toMatchObject(invalidScope);
  await expect(executor.selectByIds!(['row-a'], 'installation-b')).rejects.toMatchObject(
    invalidScope,
  );
  await expect(
    executor.erase('subject-a', 'installation-b', {
      rowLevel: 'delete-fields',
      deleteFields: ['email'],
    }),
  ).rejects.toMatchObject(invalidScope);
  await expect(
    executor.anonymize('subject-a', 'installation-b', { email: '[removed]' }),
  ).rejects.toMatchObject(invalidScope);
  expect(delegate.findMany).not.toHaveBeenCalled();
  expect(delegate.updateMany).not.toHaveBeenCalled();
  expect(delegate.deleteMany).not.toHaveBeenCalled();
});
