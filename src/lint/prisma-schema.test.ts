import { parsePrismaSchema } from './prisma-schema';

describe('parsePrismaSchema', () => {
  it('preserves quoted comment markers, enum types, optional fields and scalar lists', () => {
    const models = parsePrismaSchema(`
      generator client {
        provider = "prisma-client-js"
      }
      datasource db {
        provider = "postgresql"
        url = "postgresql://localhost/test"
      }
      enum Status {
        ACTIVE @map("active//mapped")
        CLOSED
      }
      model Profile {
        id String @id @default(cuid())
        bio String? @default("https://example.com/{path}") // actual comment
        tags String[]
        status Status
        balance Decimal @db.Decimal(12, 2)
        @@map("profiles")
      }
    `);
    expect(models).toHaveLength(1);
    expect(models[0].fields).toEqual([
      expect.objectContaining({ name: 'id', baseType: 'String', isId: true, kind: 'scalar' }),
      expect.objectContaining({
        name: 'bio',
        type: 'String?',
        optional: true,
        attributes: '@default("https://example.com/{path}")',
      }),
      expect.objectContaining({ name: 'tags', type: 'String[]', list: true, optional: false }),
      expect.objectContaining({ name: 'status', baseType: 'Status', kind: 'scalar' }),
      expect.objectContaining({
        name: 'balance',
        baseType: 'Decimal',
        attributes: '@db.Decimal(12, 2)',
      }),
    ]);
  });

  it('parses owning relations, named back references and composite identifiers', () => {
    const models = parsePrismaSchema(`
      model TenantUser {
        tenantId String
        id String
        invoices Invoice[] @relation("Billing")
        @@id([tenantId, id])
      }
      model Invoice {
        id String @id
        tenantId String
        userId String
        user TenantUser @relation("Billing", fields: [tenantId, userId], references: [tenantId, id], onDelete: Restrict, onUpdate: Cascade)
      }
    `);
    expect(models[0].fields.slice(0, 2).every((field) => field.isId)).toBe(true);
    expect(models[0].fields[2]).toMatchObject({
      kind: 'relation',
      list: true,
      relation: { target: 'Invoice', name: 'Billing', fields: [], references: [] },
    });
    expect(models[1].fields[3].relation).toEqual({
      target: 'TenantUser',
      name: 'Billing',
      fields: ['tenantId', 'userId'],
      references: ['tenantId', 'id'],
      onDelete: 'Restrict',
      onUpdate: 'Cascade',
    });
  });

  it('identifies implicit many-to-many relations so lint can reject unsupported plans', () => {
    const models = parsePrismaSchema(`
      model User {
        id String @id
        groups Group[]
      }
      model Group {
        id String @id
        users User[]
      }
    `);
    expect(models[0].fields[1].relation).toEqual({ target: 'Group', fields: [], references: [] });
    expect(models[1].fields[1].relation).toEqual({ target: 'User', fields: [], references: [] });
  });

  it.each([
    [
      'unknown type',
      'model User {\n id String @id\n secret Mystery\n}',
      'unknown field type Mystery',
    ],
    [
      'unsupported database type',
      'model User {\n id String @id\n secret Unsupported("tsvector")\n}',
      'Unsupported field declaration',
    ],
    ['unclosed model', 'model User {\n id String @id', 'Unclosed model User'],
    ['one line model', 'model User { id String @id }', 'Expected a supported block declaration'],
    [
      'duplicate model',
      'model User {\n id String\n}\nmodel User {\n id String\n}',
      'Duplicate declaration User',
    ],
    ['duplicate field', 'model User {\n id String\n id Int\n}', 'Duplicate field id'],
    [
      'second field on a line',
      'model User {\n id String email String\n}',
      'Unsupported attribute syntax',
    ],
    ['unknown attribute', 'model User {\n id String @unknown\n}', 'Unsupported field attribute'],
    [
      'multiline attribute',
      'model User {\n id String @default(\n "value"\n )\n}',
      'multiline declarations are unsupported',
    ],
    ['mismatched delimiters', 'model User {\n id String @default([1))\n}', 'Mismatched delimiters'],
    ['unclosed quote', 'model User {\n id String @default("value)\n}', 'Unclosed quoted string'],
    ['unknown block', 'view User {\n id String\n}', 'Expected a supported block declaration'],
    [
      'block comment',
      '/* comments */\nmodel User {\n id String\n}',
      'Block comments are unsupported',
    ],
    [
      'unknown block attribute',
      'model User {\n id String\n @@ignore\n}',
      'Unsupported block attribute',
    ],
    [
      'scalar relation',
      'model User {\n id String @relation("Invalid")\n}',
      '@relation requires a model field type',
    ],
    [
      'unknown composite identifier',
      'model User {\n id String\n @@id([missing])\n}',
      'Unknown or non-scalar @@id field missing',
    ],
    [
      'no model',
      'generator client {\n provider = "prisma-client-js"\n}',
      'No model declarations found',
    ],
  ])('fails closed for %s', (_name, schema, message) => {
    expect(() => parsePrismaSchema(schema)).toThrow(message);
  });

  it.each([
    ['fields: [missing], references: [id]', 'Unknown relation field missing'],
    ['fields: [parentId], references: [missing]', 'Unknown relation reference missing'],
    ['fields: [parentId]', 'matching lengths'],
    [
      'fields: [parentId], references: [id], onDelete: Unknown',
      'Unsupported referential action Unknown',
    ],
    [
      'fields: [parentId], references: [id], fields: [parentId]',
      'Duplicate relation argument fields',
    ],
    ['fields: [], references: []', 'Unsupported or duplicate identifier'],
    [
      'fields: [parentId], references: [id], unsupported: true',
      'Unsupported relation argument unsupported',
    ],
  ])('rejects malformed relation arguments %s', (args, message) => {
    expect(() =>
      parsePrismaSchema(`
      model Parent {
        id String @id
        children Child[]
      }
      model Child {
        id String @id
        parentId String
        parent Parent @relation(${args})
      }
    `),
    ).toThrow(message);
  });
});
