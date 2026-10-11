import { buildErasureEvidenceArtifact } from './erasure-evidence';
import type { ErasureEvidenceAction } from './types';

const verifiedAction: ErasureEvidenceAction = {
  entityName: 'Invoice',
  strategy: 'mixed',
  affected: 2,
  rowLevel: 'delete-row',
  effectiveRowStrategy: 'update-fields',
  deleteFields: ['email'],
  retainedFields: [{ field: 'amount', legalBasis: 'tax:KR-basic-law-sec85', count: 2 }],
  verification: {
    status: 'verified', checkedRows: 2,
    fields: [
      { field: 'email', strategy: 'delete', checked: 2, status: 'verified' },
      { field: 'amount', strategy: 'retain', checked: 2, status: 'verified' },
    ],
  },
};

describe('erasure evidence v2', () => {
  it('records effective strategy, policy identity and field-level verification', () => {
    const evidence = buildErasureEvidenceArtifact({
      requestId: 'request', tenantId: 'tenant', generatedAt: new Date('2026-01-01T00:00:00Z'),
      stats: { entities: [], policyHash: 'policy-hash', preScan: [{ entityName: 'Invoice', count: 2 }] },
      actions: [verifiedAction],
    });
    expect(evidence).toMatchObject({
      schemaVersion: 'data-subject.erasure-evidence.v2',
      policyHash: 'policy-hash', state: 'completed', verificationOverall: 'verified',
      actions: [{ rowLevel: 'delete-row', effectiveRowStrategy: 'update-fields', verification: { status: 'verified' } }],
    });
    expect(evidence).not.toHaveProperty('failureStage');
  });

  it('distinguishes compatibility evidence with no verified scope', () => {
    const evidence = buildErasureEvidenceArtifact({
      requestId: 'request', tenantId: 'tenant', generatedAt: new Date(),
      stats: { entities: [] }, actions: [{ ...verifiedAction, verification: undefined }],
    });
    expect(evidence.verificationOverall).toBe('unverified');
  });

  it('records failed verification as failed evidence with its stage', () => {
    const evidence = buildErasureEvidenceArtifact({
      requestId: 'request', tenantId: 'tenant', generatedAt: new Date(),
      state: 'failed', failureStage: 'data_execution',
      stats: { entities: [], policyHash: 'policy-hash', verificationResidual: [{ entityName: 'Invoice', count: 1 }] },
      actions: [{ ...verifiedAction, verification: { status: 'failed', checkedRows: 2, fields: [] } }],
    });
    expect(evidence).toMatchObject({ state: 'failed', verificationOverall: 'failed', failureStage: 'data_execution' });
  });
});
