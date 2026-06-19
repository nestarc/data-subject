import { lintPrismaSchema } from './lint';

describe('lintPrismaSchema', () => {
  const schema = `
    model User {
      id String @id
      tenantId String
      email String
      displayName String?
    }

    model SystemMigrationLog {
      id String @id
      actorEmail String?
    }
  `;

  it('reports PII-like fields missing from policy', () => {
    const report = lintPrismaSchema(schema, {
      registry: [
        {
          entityName: 'User',
          subjectField: 'id',
          tenantField: 'tenantId',
          fields: {
            email: 'delete',
          },
        },
      ],
      suppressions: [
        {
          model: 'SystemMigrationLog',
          reason: 'system-owned operational metadata',
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'dsr_lint_missing_policy_field',
        model: 'User',
        field: 'displayName',
      }),
    );
  });

  it('reports empty suppression reasons', () => {
    const report = lintPrismaSchema(schema, {
      suppressions: [{ model: 'SystemMigrationLog', reason: '' }],
    });

    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'dsr_lint_empty_suppression_reason',
        model: 'SystemMigrationLog',
      }),
    );
  });
});
