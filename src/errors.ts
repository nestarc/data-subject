export const DataSubjectErrorCode = {
  SubjectNotFound: 'dsr_subject_not_found',
  UnregisteredEntity: 'dsr_unregistered_entity',
  InvalidPolicy: 'dsr_invalid_policy',
  VerificationFailed: 'dsr_verification_failed',
  AnonymizeDynamicReplacement: 'dsr_anonymize_dynamic_replacement',
} as const;

export type DataSubjectErrorCode =
  (typeof DataSubjectErrorCode)[keyof typeof DataSubjectErrorCode];

const HTTP_STATUS: Record<DataSubjectErrorCode, number> = {
  dsr_subject_not_found: 404,
  dsr_unregistered_entity: 500,
  dsr_invalid_policy: 500,
  dsr_verification_failed: 500,
  dsr_anonymize_dynamic_replacement: 500,
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
