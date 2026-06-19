import type {
  ErasureEvidenceAction,
  ErasureEvidenceArtifact,
  RequestStats,
} from './types';

export interface BuildErasureEvidenceInput {
  requestId: string;
  tenantId: string;
  generatedAt: Date;
  stats: RequestStats;
  actions: ErasureEvidenceAction[];
}

export function buildErasureEvidenceArtifact(
  input: BuildErasureEvidenceInput,
): ErasureEvidenceArtifact {
  return {
    schemaVersion: 'data-subject.erasure-evidence.v1',
    requestId: input.requestId,
    tenantId: input.tenantId,
    requestType: 'erase',
    generatedAt: input.generatedAt.toISOString(),
    state: 'completed',
    preScan: input.stats.preScan ?? [],
    actions: input.actions,
    postScan: input.stats.postScan ?? [],
    verificationResidual: input.stats.verificationResidual ?? [],
    artifactHashAlgorithm: 'sha256',
  };
}
