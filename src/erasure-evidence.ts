import type {
  ErasureEvidenceAction,
  ErasureEvidenceArtifact,
  FailureStage,
  RequestStats,
} from './types';

export interface BuildErasureEvidenceInput {
  requestId: string;
  tenantId: string;
  generatedAt: Date;
  stats: RequestStats;
  actions: ErasureEvidenceAction[];
  state?: 'completed' | 'failed';
  failureStage?: FailureStage;
}

export function buildErasureEvidenceArtifact(
  input: BuildErasureEvidenceInput,
): ErasureEvidenceArtifact {
  return {
    schemaVersion: 'data-subject.erasure-evidence.v2',
    policyHash: input.stats.policyHash,
    verificationOverall: input.actions.some(action => action.verification?.status === 'failed') ? 'failed'
      : input.actions.every(action => action.verification?.status === 'verified') ? 'verified' : 'unverified',
    requestId: input.requestId,
    tenantId: input.tenantId,
    requestType: 'erase',
    generatedAt: input.generatedAt.toISOString(),
    state: input.state ?? 'completed',
    ...(input.failureStage ? { failureStage: input.failureStage } : {}),
    preScan: input.stats.preScan ?? [],
    actions: input.actions,
    postScan: input.stats.postScan ?? [],
    verificationResidual: input.stats.verificationResidual ?? [],
    artifactHashAlgorithm: 'sha256',
  };
}
