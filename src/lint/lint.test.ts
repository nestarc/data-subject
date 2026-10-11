import { lintPrismaSchema } from './lint';
import { definePolicy, type EntityDefinition } from '../policy-definition';

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

describe('shared policy schema lint', () => {
  const simple = `model User {
    id String @id
    subjectId String
    tenantId String
    email String?
    opaquePayload Json?
  }`;
  const base: EntityDefinition = {
    entityName: 'User',
    subjectField: 'subjectId',
    stableIdField: 'id',
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    fields: { email: 'delete' },
    ignoredFields: { opaquePayload: 'system-owned aggregate, reviewed by owner' },
  };
  const relatedSchema = `model User {
    id String @id
    subjectId String
    tenantId String
    email String?
    invoices Invoice[]
  }
  model Invoice {
    id String @id
    subjectId String
    tenantId String
    userId String
    amount Int
    note String?
    user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  }`;
  const related: EntityDefinition[] = [
    { ...base, rowLevel: 'delete-row', ignoredFields: {}, relations: ['invoices'] },
    {
      entityName: 'Invoice',
      subjectField: 'subjectId',
      stableIdField: 'id',
      scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
      rowLevel: 'delete-row',
      fields: { userId: 'delete', amount: 'delete', note: 'delete' },
      relations: ['user'],
      dependsOn: ['User'],
    },
  ];

  it('catches arbitrary newly added scalar fields without guessing PII names', () => {
    const schema = simple.replace('opaquePayload Json?', 'opaquePayload Json?\n    x42 String?');
    const report = lintPrismaSchema(schema, { definitions: definePolicy([base]) });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_missing_policy_field', field: 'x42' }),
    );
    expect(lintPrismaSchema(simple, { definitions: [base] }).ok).toBe(true);
  });

  it('does not let a field suppression hide the whole model', () => {
    const report = lintPrismaSchema(simple, {
      registry: [],
      strictCoverage: true,
      suppressions: [{ model: 'User', field: 'email', reason: 'one field only' }],
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_unregistered_model', model: 'User' }),
    );
  });

  it('rejects required scalar nulling and detects nullable-to-required schema changes', () => {
    const report = lintPrismaSchema(simple.replace('email String?', 'email String'), {
      definitions: [base],
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_nonnullable_write', field: 'email' }),
    );
    expect(
      lintPrismaSchema(simple.replace('email String?', 'email String'), {
        definitions: [{ ...base, rowLevel: 'delete-row' }],
      }).ok,
    ).toBe(true);
  });

  it('requires reasoned exclusions even for fields without PII-like names', () => {
    const report = lintPrismaSchema(simple, {
      definitions: [{ ...base, ignoredFields: { opaquePayload: ' ' } }],
    });
    expect(report.ok).toBe(false);
    expect(report.findings[0].code).toBe('dsr_lint_invalid_policy');
  });

  it('accepts declared child-before-parent row deletion without automatic relation traversal', () => {
    expect(lintPrismaSchema(relatedSchema, { definitions: related })).toEqual({
      ok: true,
      findings: [],
    });
  });

  it('rejects missing child order and unmapped relation fields', () => {
    const definitions = structuredClone(related);
    delete definitions[1].dependsOn;
    delete definitions[0].relations;
    const report = lintPrismaSchema(relatedSchema, { definitions });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_dependency_order', model: 'Invoice' }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_unmapped_relation', field: 'invoices' }),
    );
  });

  it('detects retained child data that a parent cascade would destroy', () => {
    const definitions = structuredClone(related);
    definitions[1].fields.amount = { strategy: 'retain', legalBasis: 'tax:law' };
    const report = lintPrismaSchema(relatedSchema, { definitions });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: 'dsr_lint_retention_conflict',
        model: 'Invoice',
        field: 'user',
      }),
    );
  });

  it('does not let whole-model exclusions hide a relation to a registered parent', () => {
    const report = lintPrismaSchema(relatedSchema, {
      definitions: [related[0]],
      suppressions: [{ model: 'Invoice', reason: 'external owner' }],
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_unmapped_relation', model: 'Invoice' }),
    );
  });

  it('accepts detaching a nullable foreign key before deleting its parent while retaining values', () => {
    const definitions = structuredClone(related);
    definitions[1].rowLevel = 'delete-fields';
    definitions[1].fields.amount = { strategy: 'retain', legalBasis: 'tax:law' };
    const schema = relatedSchema
      .replace('userId String', 'userId String?')
      .replace('user User @relation', 'user User? @relation');
    expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });
  });

  it.each(['delete', { strategy: 'anonymize', replacement: null }] as const)(
    'accepts composite FK detachment by one nullable component while retaining required tenantId (%p)',
    (userPolicy) => {
      const definitions = structuredClone(related);
      definitions[1].rowLevel = 'delete-fields';
      definitions[1].fields.tenantId = { strategy: 'retain', legalBasis: 'tax:law' };
      definitions[1].fields.userId = userPolicy;
      definitions[1].fields.amount = { strategy: 'retain', legalBasis: 'tax:law' };
      const schema = relatedSchema
        .replace('userId String', 'userId String?')
        .replace('user User @relation', 'user User? @relation')
        .replace(
          'fields: [userId], references: [id]',
          'fields: [tenantId, userId], references: [tenantId, id]',
        )
        .replace('invoices Invoice[]', 'invoices Invoice[]\n    @@unique([tenantId, id])');
      expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });

      definitions[1].fields.userId = { strategy: 'retain', legalBasis: 'tax:law' };
      expect(lintPrismaSchema(schema, { definitions }).findings).toContainEqual(
        expect.objectContaining({ code: 'dsr_lint_retention_conflict', field: 'user' }),
      );
      definitions[1].fields.userId = { strategy: 'anonymize', replacement: 'still-linked' };
      expect(lintPrismaSchema(schema, { definitions }).ok).toBe(false);
    },
  );

  it.each(['Cascade', 'SetNull', 'Restrict', 'NoAction', 'default'])(
    'rejects linked child retention when a referenced parent field is updated (onUpdate %s)',
    (action) => {
      const schema = relatedSchema
        .replace('email String?', 'email String?\n    referenceCode String? @unique')
        .replace('userId String', 'userId String?')
        .replace('user User @relation', 'user User? @relation')
        .replace(
          'references: [id], onDelete: Cascade',
          `references: [referenceCode]${action === 'default' ? '' : `, onUpdate: ${action}`}`,
        );
      const definitions = structuredClone(related);
      definitions[0].rowLevel = 'delete-fields';
      definitions[0].fields.referenceCode = { strategy: 'anonymize', replacement: '[removed]' };
      definitions[1].rowLevel = 'delete-fields';
      definitions[1].fields.userId = { strategy: 'retain', legalBasis: 'tax:law' };
      definitions[1].fields.amount = { strategy: 'retain', legalBasis: 'tax:law' };
      delete definitions[1].dependsOn;
      const report = lintPrismaSchema(schema, { definitions });
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'dsr_lint_dependency_order', model: 'Invoice' }),
      );
      expect(report.findings).toContainEqual(
        expect.objectContaining({ code: 'dsr_lint_retention_conflict', field: 'user' }),
      );
      expect(
        report.findings.some((finding) =>
          finding.message.includes(action === 'default' ? 'Prisma default' : action),
        ),
      ).toBe(true);

      definitions[1].dependsOn = ['User'];
      definitions[1].fields.userId = 'delete';
      expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });
      definitions[0].fields.referenceCode = 'delete';
      expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });
      definitions[1].fields.userId = {
        strategy: 'anonymize',
        replacement: 'joint-change-is-unsupported',
      };
      expect(lintPrismaSchema(schema, { definitions }).ok).toBe(false);
    },
  );

  it('allows child row deletion before a referenced parent key update', () => {
    const schema = relatedSchema
      .replace('email String?', 'email String?\n    referenceCode String @unique')
      .replace(
        'references: [id], onDelete: Cascade',
        'references: [referenceCode], onUpdate: Cascade',
      );
    const definitions = structuredClone(related);
    definitions[0].rowLevel = 'delete-fields';
    definitions[0].fields.referenceCode = { strategy: 'anonymize', replacement: '[removed]' };
    expect(lintPrismaSchema(schema, { definitions })).toEqual({ ok: true, findings: [] });
  });

  it('does not require child deletion for parent updates unrelated to referenced keys', () => {
    const definitions = structuredClone(related);
    definitions[0].rowLevel = 'delete-fields';
    definitions[1].fields = { amount: { strategy: 'retain', legalBasis: 'tax:law' } };
    definitions[1].ignoredFields = {
      userId: 'retained relation',
      note: 'non-personal bookkeeping',
    };
    delete definitions[1].dependsOn;
    expect(lintPrismaSchema(relatedSchema, { definitions })).toEqual({ ok: true, findings: [] });
  });

  it('rejects cyclic dependency declarations and implicit many-to-many relations', () => {
    const definitions = structuredClone(related);
    definitions[0].dependsOn = ['Invoice'];
    const report = lintPrismaSchema(relatedSchema, { definitions });
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_dependency_cycle' }),
    );
    const implicitSchema = relatedSchema.replace(
      'user User @relation(fields: [userId], references: [id], onDelete: Cascade)',
      'users User[]',
    );
    definitions[1].relations = ['users'];
    const implicit = lintPrismaSchema(implicitSchema, { definitions });
    expect(implicit.findings).toContainEqual(
      expect.objectContaining({ code: 'dsr_lint_relation_conflict' }),
    );
  });

  it('reports malformed or unsupported schema syntax instead of silently passing', () => {
    const report = lintPrismaSchema('model User {\n id String @id', { definitions: [base] });
    expect(report).toMatchObject({
      ok: false,
      findings: [{ code: 'dsr_lint_schema_unsupported' }],
    });
  });

  it('fails malformed JSON lint configuration without throwing', () => {
    expect(lintPrismaSchema(simple, { registry: [null] } as never).ok).toBe(false);
    expect(
      lintPrismaSchema(simple, {
        registry: [{ entityName: 'User', subjectField: 'id', fields: null }],
      } as never).ok,
    ).toBe(false);
    expect(lintPrismaSchema(simple, { piiFieldPatterns: [1] } as never).ok).toBe(false);
  });
});
