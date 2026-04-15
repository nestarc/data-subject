export const DataSubjectErrorCode = {
  SubjectNotFound: 'dsr_subject_not_found',
  UnregisteredEntity: 'dsr_unregistered_entity',
  InvalidPolicy: 'dsr_invalid_policy',
  VerificationFailed: 'dsr_verification_failed',
  AnonymizeDynamicReplacement: 'dsr_anonymize_dynamic_replacement',
  EntityAlreadyRegistered: 'dsr_entity_already_registered',
  RequestConflict: 'dsr_request_conflict',
  RequestNotFound: 'dsr_request_not_found',
} as const;

export type DataSubjectErrorCode =
  (typeof DataSubjectErrorCode)[keyof typeof DataSubjectErrorCode];

const HTTP_STATUS: Record<DataSubjectErrorCode, number> = {
  dsr_subject_not_found: 404,
  dsr_unregistered_entity: 500,
  dsr_invalid_policy: 500,
  dsr_verification_failed: 500,
  dsr_anonymize_dynamic_replacement: 500,
  dsr_entity_already_registered: 500,
  dsr_request_conflict: 409,
  dsr_request_not_found: 404,
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
