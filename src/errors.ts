import type { RequestLifecycle } from './types';

export const DataSubjectErrorCode = {
  SubjectNotFound: 'dsr_subject_not_found',
  UnregisteredEntity: 'dsr_unregistered_entity',
  InvalidPolicy: 'dsr_invalid_policy',
  VerificationFailed: 'dsr_verification_failed',
  AnonymizeDynamicReplacement: 'dsr_anonymize_dynamic_replacement',
  EntityAlreadyRegistered: 'dsr_entity_already_registered',
  RequestConflict: 'dsr_request_conflict',
  RequestNotFound: 'dsr_request_not_found',
  ArtifactWriteFailed: 'dsr_artifact_write_failed',
  ArtifactExpired: 'dsr_artifact_expired',
  InvalidStateTransition: 'dsr_invalid_state_transition',
  EvidenceReportInvalid: 'dsr_evidence_report_invalid',
  InvalidInput: 'dsr_invalid_input',
  InvalidScope: 'dsr_invalid_scope',
  RequestPersistenceFailed: 'dsr_request_persistence_failed',
  PlanMismatch: 'dsr_plan_mismatch',
  PlanExpired: 'dsr_plan_expired',
  VerificationUnavailable: 'dsr_verification_unavailable',
  DurableExecutionRequired: 'dsr_durable_execution_required',
} as const;

export type DataSubjectErrorCode = (typeof DataSubjectErrorCode)[keyof typeof DataSubjectErrorCode];

const HTTP_STATUS: Record<DataSubjectErrorCode, number> = {
  dsr_subject_not_found: 404,
  dsr_unregistered_entity: 500,
  dsr_invalid_policy: 500,
  dsr_verification_failed: 500,
  dsr_anonymize_dynamic_replacement: 500,
  dsr_entity_already_registered: 500,
  dsr_request_conflict: 409,
  dsr_request_not_found: 404,
  dsr_artifact_write_failed: 500,
  dsr_artifact_expired: 410,
  dsr_invalid_state_transition: 500,
  dsr_evidence_report_invalid: 500,
  dsr_invalid_input: 400,
  dsr_invalid_scope: 400,
  dsr_request_persistence_failed: 500,
  dsr_plan_mismatch: 409,
  dsr_plan_expired: 409,
  dsr_verification_unavailable: 400,
  dsr_durable_execution_required: 400,
};

export class DataSubjectError extends Error {
  readonly code: DataSubjectErrorCode;
  readonly httpStatus: number;

  constructor(code: DataSubjectErrorCode, reason?: string) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = 'DataSubjectError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** An indeterminate storage failure: reconcile this ID before executing again. */
export class DataSubjectPersistenceError extends DataSubjectError {
  readonly recovery = 'reconcile_request' as const;

  constructor(
    readonly requestId: string,
    readonly tenantId: string,
    readonly dataOutcome: RequestLifecycle['dataOutcome'],
  ) {
    super(DataSubjectErrorCode.RequestPersistenceFailed);
    this.name = 'DataSubjectPersistenceError';
  }
}
