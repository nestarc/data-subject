import { createHash } from 'node:crypto';

export function sha256Hex(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function exportArtifactKey(tenantId: string, requestId: string): string {
  return dataSubjectArtifactKey(tenantId, requestId, 'export.zip');
}

export function erasureEvidenceArtifactKey(
  tenantId: string,
  requestId: string,
): string {
  return dataSubjectArtifactKey(tenantId, requestId, 'erase-evidence.json');
}

function dataSubjectArtifactKey(
  tenantId: string,
  requestId: string,
  fileName: string,
): string {
  return `data-subject/${keySegment(tenantId)}/${keySegment(
    requestId,
  )}/${fileName}`;
}

function keySegment(value: string): string {
  return encodeURIComponent(value);
}
