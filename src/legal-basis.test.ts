import { validateLegalBasis, type LegalBasisOptions } from './legal-basis';

describe('validateLegalBasis (non-strict)', () => {
  it('accepts any non-empty string', () => {
    expect(validateLegalBasis('tax:KR-basic-law-art85')).toBeNull();
    expect(validateLegalBasis('accountability')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateLegalBasis('')).toMatch(/empty/);
  });

  it('rejects whitespace-only', () => {
    expect(validateLegalBasis('   ')).toMatch(/empty/);
  });
});

describe('validateLegalBasis (strict)', () => {
  const opts: LegalBasisOptions = { strict: true };

  it('requires scheme:jurisdiction-reference form', () => {
    expect(validateLegalBasis('tax:KR-basic-law-art85', opts)).toBeNull();
    expect(validateLegalBasis('accountability:gdpr-art-5-2', opts)).toBeNull();
  });

  it('rejects missing scheme', () => {
    expect(validateLegalBasis('tax-records', opts)).toMatch(/scheme/);
  });

  it('rejects missing reference', () => {
    expect(validateLegalBasis('tax:', opts)).toMatch(/reference/);
  });
});
