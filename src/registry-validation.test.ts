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

  it('can warn when tenant metadata must be verified elsewhere', () => {
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

    expect(report.ok).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'dsr_lint_missing_tenant_field',
      }),
    );
  });
});
