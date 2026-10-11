import { createHash } from 'node:crypto';

import JSZip from 'jszip';

import { exportArtifactKey } from '../../src/artifacts';
import { DataSubjectErrorCode } from '../../src/errors';
import { ExportRunner } from '../../src/export-runner';
import { fromPrisma } from '../../src/prisma/from-prisma';
import { Registry } from '../../src/registry';
import { InMemoryArtifactStorage } from '../../src/storage/in-memory-artifact-storage';
import type { EntityExecutor } from '../../src/types';

function mockExecutor(rows: Record<string, unknown>[]): EntityExecutor {
  return {
    select: async () => rows,
    erase: async () => 0,
    anonymize: async () => 0,
  };
}

describe('ExportRunner', () => {
  it('collects rows across registered entities into a zip', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
        exportFields: ['id', 'email'],
      },
      executor: mockExecutor([{ id: 'u1', email: 'a@b.com' }]),
    });
    registry.register({
      policy: {
        entityName: 'Order',
        subjectField: 'customerId',
        fields: { note: 'delete' },
        exportFields: ['id', 'note'],
      },
      executor: mockExecutor([{ id: 'o1', note: 'test' }]),
    });
    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);

    const result = await runner.run('dsr_1', 'subject_1', 'tenant_1');

    expect(result.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.stats.entities.map((entry) => entry.entityName).sort()).toEqual([
      'Order',
      'User',
    ]);
    expect(result.stats.entities.every((entry) => entry.strategy === 'export')).toBe(
      true,
    );

    const stored = await artifacts.get(exportArtifactKey('tenant_1', 'dsr_1'));
    expect(stored).not.toBeNull();

    const zip = await JSZip.loadAsync(stored!.body);
    const userJson = await zip.file('User.json')?.async('string');
    expect(JSON.parse(userJson ?? '[]')[0].email).toBe('a@b.com');
  });

  it('verifies hash matches the stored zip bytes', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete' },
        exportFields: ['id'],
      },
      executor: mockExecutor([{ id: 'u1' }]),
    });

    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);
    const result = await runner.run('dsr_2', 'subject_1', 'tenant_1');
    const stored = await artifacts.get(exportArtifactKey('tenant_1', 'dsr_2'));
    const expected = createHash('sha256').update(stored!.body).digest('hex');

    expect(result.artifactHash).toBe(expected);
  });

  it('preserves allowlisted BigInt values as decimal strings throughout the ZIP payload', async () => {
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'Account', subjectField: 'subjectId',
        fields: { balance: 'delete', secret: 'delete' },
        exportFields: ['id', 'balance', 'details', 'createdAt'],
      },
      executor: fromPrisma({
        subjectField: 'subjectId', tenantField: 'tenantId',
        delegate: {
          findMany: async () => [{
            id: 9007199254740993n,
            subjectId: 'subject', tenantId: 'tenant',
            balance: -9007199254740995n,
            details: { values: [0n, { count: 18446744073709551615n }], regularNumber: 42 },
            createdAt: new Date('2026-10-11T00:00:00.000Z'),
            secret: 99999999999999999999n,
          }],
          deleteMany: async () => ({ count: 0 }),
          updateMany: async () => ({ count: 0 }),
        },
      }),
    });
    const artifacts = new InMemoryArtifactStorage();
    const result = await new ExportRunner(registry, artifacts).run('request', 'subject', 'tenant');
    const stored = await artifacts.get(exportArtifactKey('tenant', 'request'));
    const zip = await JSZip.loadAsync(stored!.body);
    const text = await zip.file('Account.json')!.async('string');

    expect(JSON.parse(text)).toEqual([{
      id: '9007199254740993',
      balance: '-9007199254740995',
      details: { values: ['0', { count: '18446744073709551615' }], regularNumber: 42 },
      createdAt: '2026-10-11T00:00:00.000Z',
    }]);
    expect(text).not.toMatch(/secret|99999999999999999999|subjectId|tenantId/);
    expect(result.artifactHash).toBe(createHash('sha256').update(stored!.body).digest('hex'));
    expect(result.stats.entities).toEqual([{ entityName: 'Account', affected: 1, strategy: 'export' }]);
  });

  it('exports only own allowlisted fields, excluding secrets even when erasure policy includes them', async () => {
    const registry = new Registry();
    const row = Object.assign(Object.create({ inherited: 'hidden' }), {
      id: 'u1',
      email: 'a@b.com',
      passwordHash: 'secret-hash',
      accessToken: 'secret-token',
      internalNote: 'secret-note',
    }) as Record<string, unknown>;
    registry.register({
      policy: {
        entityName: 'User',
        subjectField: 'userId',
        fields: { email: 'delete', passwordHash: 'delete', accessToken: 'delete' },
        exportFields: ['id', 'email', 'inherited', 'missing'],
      },
      executor: mockExecutor([row]),
    });
    const artifacts = new InMemoryArtifactStorage();
    await new ExportRunner(registry, artifacts).run('request', 's1', 't1');
    const stored = await artifacts.get(exportArtifactKey('t1', 'request'));
    const zip = await JSZip.loadAsync(stored!.body);
    const text = await zip.file('User.json')!.async('string');
    expect(JSON.parse(text)).toEqual([{ id: 'u1', email: 'a@b.com' }]);
    expect(text).not.toMatch(/secret|hidden/);
  });

  it('never reads or exports erase-only entities without an explicit allowlist', async () => {
    const select = jest.fn(async () => [{ passwordHash: 'secret' }]);
    const registry = new Registry();
    registry.register({
      policy: { entityName: 'Credentials', subjectField: 'userId', fields: { passwordHash: 'delete' } },
      executor: { ...mockExecutor([]), select },
    });
    const artifacts = new InMemoryArtifactStorage();
    const result = await new ExportRunner(registry, artifacts).run('request', 's1', 't1');
    const stored = await artifacts.get(exportArtifactKey('t1', 'request'));
    const zip = await JSZip.loadAsync(stored!.body);
    expect(select).not.toHaveBeenCalled();
    expect(Object.keys(zip.files)).toEqual([]);
    expect(result.stats.entities).toEqual([]);
  });

  it('prepares bytes without writing and reports artifact write errors separately', async () => {
    const registry = new Registry();
    const put = jest.fn(async () => { throw new Error('backend secret'); });
    const runner = new ExportRunner(registry, { put, get: async () => null });
    const prepared = await runner.prepare('request', 's1', 't1');
    expect(put).not.toHaveBeenCalled();
    await expect(runner.upload('request', 't1', prepared)).rejects.toMatchObject({
      code: DataSubjectErrorCode.ArtifactWriteFailed,
    });
    await expect(runner.run('request', 's1', 't1')).rejects.not.toThrow(/backend secret/);
  });

  it('separates ZIP contents and keys for tenants sharing the same subject ID', async () => {
    const rows = [
      { userId: 'shared', tenantId: 't1', email: 'first@example.com', passwordHash: 'secret1' },
      { userId: 'shared', tenantId: 't2', email: 'second@example.com', passwordHash: 'secret2' },
    ];
    const registry = new Registry();
    registry.register({
      policy: {
        entityName: 'User', subjectField: 'userId',
        fields: { email: 'delete', passwordHash: 'delete' }, exportFields: ['email'],
      },
      executor: fromPrisma({
        subjectField: 'userId', tenantField: 'tenantId',
        delegate: {
          findMany: async ({ where }) => rows.filter((row) =>
            Object.entries(where).every(([key, value]) => row[key as keyof typeof row] === value)),
          deleteMany: async () => ({ count: 0 }),
          updateMany: async () => ({ count: 0 }),
        },
      }),
    });
    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);
    await runner.run('same-request', 'shared', 't1');
    await runner.run('same-request', 'shared', 't2');
    for (const [tenantId, email] of [['t1', 'first@example.com'], ['t2', 'second@example.com']]) {
      const stored = await artifacts.get(exportArtifactKey(tenantId, 'same-request'));
      const zip = await JSZip.loadAsync(stored!.body);
      expect(JSON.parse(await zip.file('User.json')!.async('string'))).toEqual([{ email }]);
    }
    expect(await artifacts.get(exportArtifactKey('t3', 'same-request'))).toBeNull();
  });
});
