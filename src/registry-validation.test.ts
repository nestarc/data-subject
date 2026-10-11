import { Registry } from './registry';
import { validateRegistry } from './registry-validation';

describe('validateRegistry', () => {
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
    expect(validateRegistry(registry, { requireTenantField: true })).toEqual({ ok: true, findings: [] });
  });
});
