export interface LegalBasisOptions {
  strict?: boolean;
}

const STRICT_FORMAT = /^[a-z][a-z0-9-]*:[^\s].*$/i;

export function validateLegalBasis(
  value: string,
  opts: LegalBasisOptions = {},
): string | null {
  if (!value || value.trim().length === 0) {
    return 'legalBasis is empty';
  }

  if (opts.strict) {
    if (!value.includes(':')) {
      return 'legalBasis missing scheme (expected "scheme:reference")';
    }

    const [, ref] = value.split(':', 2);
    if (!ref || ref.trim().length === 0) {
      return 'legalBasis missing reference after scheme';
    }

    if (!STRICT_FORMAT.test(value)) {
      return 'legalBasis does not match "scheme:reference" format';
    }
  }

  return null;
}
