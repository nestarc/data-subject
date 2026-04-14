import { DataSubjectError, DataSubjectErrorCode } from './errors';

describe('DataSubjectError', () => {
  it('carries a code and http status', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.SubjectNotFound);

    expect(err.code).toBe('dsr_subject_not_found');
    expect(err.httpStatus).toBe(404);
  });

  it('invalid policy maps to 500', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.InvalidPolicy);

    expect(err.httpStatus).toBe(500);
  });

  it('preserves an optional reason', () => {
    const err = new DataSubjectError(DataSubjectErrorCode.InvalidPolicy, 'missing legalBasis');

    expect(err.message).toContain('missing legalBasis');
  });
});
