import { createHash } from 'node:crypto';

import JSZip from 'jszip';

import type { Registry } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStats } from './types';

export interface ExportResult {
  artifactHash: string;
  artifactUrl: string;
  stats: RequestStats;
}

export class ExportRunner {
  constructor(
    private readonly registry: Registry,
    private readonly artifacts: ArtifactStorage,
  ) {}

  async run(
    requestId: string,
    subjectId: string,
    tenantId: string,
  ): Promise<ExportResult> {
    const zip = new JSZip();
    const entities: RequestStats['entities'] = [];

    for (const entry of this.registry.list()) {
      const rows = await entry.executor.select(subjectId, tenantId);
      zip.file(`${entry.policy.entityName}.json`, JSON.stringify(rows, null, 2));
      entities.push({
        entityName: entry.policy.entityName,
        affected: rows.length,
        strategy: 'delete',
      });
    }

    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const artifactHash = createHash('sha256').update(body).digest('hex');
    const artifactUrl = await this.artifacts.put(
      `${requestId}.zip`,
      body,
      'application/zip',
    );

    return { artifactHash, artifactUrl, stats: { entities } };
  }
}
