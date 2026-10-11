import { Registry } from './registry';
import { validateRegistry } from './registry-validation';

describe('validateRegistry', () => {
  it('requires reviewed exclusions when checking a full schema with operational models', () => {
    const registry = new Registry();
    registry.registerDefinition({
      entityName: 'Profile', subjectField: 'subjectId', stableIdField: 'id',
      scope: { mode: 'multi-tenant', tenantField: 'tenantId' }, fields: { email: 'delete' },
    }, {
      scope: { mode: 'multi-tenant', tenantField: 'tenantId' }, identityField: 'id',
      select: async () => [], erase: async () => 0, anonymize: async () => 0,
    });
    const schemaSource = `model Profile {
      id String @id
      subjectId String
      tenantId String
      email String?
    }
    model DataSubjectJob {
      id String @id
      payload Json
    }`;
    expect(validateRegistry(registry, { schemaSource }).ok).toBe(false);
    expect(validateRegistry(registry, {
      schemaSource, suppressions: [{ model: 'DataSubjectJob', reason: 'Operational queue has its own expiry and cleanup' }],
    }).ok).toBe(true);
    expect(validateRegistry(registry, {
      schemaSource, suppressions: [{ model: 'DataSubjectJob', reason: '' }],
    }).ok).toBe(false);
  });

  it('uses shared definitions to validate schema drift', () => {
    const registry = new Registry();
    registry.registerDefinition(
      {
        entityName: 'User',
        subjectField: 'subjectId',
        stableIdField: 'id',
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
        fields: { email: 'delete' },
      },
      {
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
        select: async () => [],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    );
    const schemaSource = `model User {
      id String @id
      subjectId String
      tenantId String
      email String?
      newPayload Json?
    }`;
    const report = validateRegistry(registry, { schemaSource });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_missing_policy_field', field: 'newPayload' }),
    );
  });

  it('returns ok for a basic registry', () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: {
        select: async () => [],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });

    expect(validateRegistry(registry)).toEqual({
      ok: true,
      findings: [],
    });
  });

  it('fails required tenant validation when executor metadata is missing', () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
      },
      executor: {
        select: async () => [],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });

    const report = validateRegistry(registry, { requireTenantField: true });

    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: 'error',
        code: 'dsr_lint_missing_tenant_field',
      }),
    );
  });

  it('accepts multi-tenant executor metadata', () => {
    const registry = new Registry();
    registry.register({
      policy: { entityName: 'User', subjectField: 'userId', fields: { email: 'delete' } },
      executor: {
        scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
        select: async () => [],
        erase: async () => 0,
        anonymize: async () => 0,
      },
    });
    expect(validateRegistry(registry, { requireTenantField: true })).toEqual({
      ok: true,
      findings: [],
    });
  });
});
