import JSZip from 'jszip';

import { exportArtifactKey, sha256Hex } from './artifacts';
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import type { Registry } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStats } from './types';

export interface ExportResult {
  artifactHash: string;
  artifactUrl: string;
  stats: RequestStats;
}

export interface PreparedExport {
  body: Buffer;
  artifactHash: string;
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
    const prepared = await this.prepare(requestId, subjectId, tenantId);
    return this.upload(requestId, tenantId, prepared);
  }

  async prepare(
    _requestId: string,
    subjectId: string,
    tenantId: string,
  ): Promise<PreparedExport> {
    const zip = new JSZip();
    const entities: RequestStats['entities'] = [];

    for (const entry of this.registry.list()) {
      if (entry.policy.exportFields.length === 0) {
        continue;
      }
      const rows = await entry.executor.select(subjectId, tenantId);
      const projected = rows.map((row) =>
        Object.fromEntries(
          entry.policy.exportFields
            .filter((field) => Object.prototype.hasOwnProperty.call(row, field))
            .map((field) => [field, row[field]]),
        ),
      );
      zip.file(`${entry.policy.entityName}.json`, JSON.stringify(projected, null, 2));
      entities.push({
        entityName: entry.policy.entityName,
        affected: rows.length,
        strategy: 'export',
      });
    }

    const body = await zip.generateAsync({ type: 'nodebuffer' });
    const artifactHash = sha256Hex(body);
    return { body, artifactHash, stats: { entities } };
  }

  async upload(
    requestId: string,
    tenantId: string,
    prepared: PreparedExport,
  ): Promise<ExportResult> {
    let artifactUrl: string;
    try {
      artifactUrl = await this.artifacts.put(
        exportArtifactKey(tenantId, requestId),
        prepared.body,
        'application/zip',
      );
    } catch {
      throw new DataSubjectError(
        DataSubjectErrorCode.ArtifactWriteFailed,
        'Failed to store the export artifact',
      );
    }

    return { artifactHash: prepared.artifactHash, artifactUrl, stats: prepared.stats };
  }
}
