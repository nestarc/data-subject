import { createHash } from 'node:crypto';

import JSZip from 'jszip';

import { ExportRunner } from '../../src/export-runner';
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
      },
      executor: mockExecutor([{ id: 'u1', email: 'a@b.com' }]),
    });
    registry.register({
      policy: {
        entityName: 'Order',
        subjectField: 'customerId',
        fields: { note: 'delete' },
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

    const stored = await artifacts.get('dsr_1.zip');
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
      },
      executor: mockExecutor([{ id: 'u1' }]),
    });

    const artifacts = new InMemoryArtifactStorage();
    const runner = new ExportRunner(registry, artifacts);
    const result = await runner.run('dsr_2', 'subject_1', 'tenant_1');
    const stored = await artifacts.get('dsr_2.zip');
    const expected = createHash('sha256').update(stored!.body).digest('hex');

    expect(result.artifactHash).toBe(expected);
  });
});
