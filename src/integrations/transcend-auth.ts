import { createPublicKey, verify, type KeyObject } from 'node:crypto';

export class TranscendIntegrationError extends Error {
  constructor(
    readonly code:
      | 'invalid_configuration'
      | 'invalid_webhook'
      | 'unauthorized_webhook'
      | 'unsupported_request'
      | 'subject_not_mapped'
      | 'invalid_job'
      | 'provider_unavailable'
      | 'local_execution_incomplete',
    readonly retryable = false,
  ) {
    super(`transcend_${code}`);
    this.name = 'TranscendIntegrationError';
  }
}

export function signingKeys(pems: readonly string[]): KeyObject[] {
  try {
    if (!Array.isArray(pems) || pems.length < 1 || pems.length > 5) throw new Error();
    return pems.map((pem) => {
      const key = createPublicKey(pem);
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'secp384r1')
        throw new Error();
      return key;
    });
  } catch {
    throw new TranscendIntegrationError('invalid_configuration');
  }
}

/** Sombra authenticates a bearer JWT; its public contract does not sign the raw HTTP body. */
export function verifySombraToken(
  token: string,
  keys: readonly KeyObject[],
  audience: string,
  now: Date,
): void {
  try {
    if (token.length > 16_384) throw new Error();
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
      throw new Error();
    const header = jsonObject(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const claims = jsonObject(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (header.alg !== 'ES384' || header.crit !== undefined || header.b64 !== undefined)
      throw new Error();
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.length !== 96 || signature.toString('base64url') !== parts[2]) throw new Error();
    if (
      !keys.some((key) =>
        verify(
          'sha384',
          Buffer.from(`${parts[0]}.${parts[1]}`),
          { key, dsaEncoding: 'ieee-p1363' },
          signature,
        ),
      )
    )
      throw new Error();
    if (
      claims.scope !== 'coreIdentifier' ||
      !(claims.aud === audience || (Array.isArray(claims.aud) && claims.aud.includes(audience)))
    )
      throw new Error();
    const seconds = now.getTime() / 1000;
    if (!Number.isFinite(seconds)) throw new Error();
    for (const field of ['exp', 'nbf', 'iat'] as const) {
      if (claims[field] !== undefined && !Number.isFinite(claims[field])) throw new Error();
    }
    if (typeof claims.exp === 'number' && seconds >= claims.exp) throw new Error();
    if (typeof claims.nbf === 'number' && seconds < claims.nbf) throw new Error();
    if (typeof claims.iat === 'number' && seconds < claims.iat) throw new Error();
  } catch {
    throw new TranscendIntegrationError('unauthorized_webhook');
  }
}

export function jsonObject(value: string): Record<string, unknown> {
  return object(JSON.parse(value));
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TranscendIntegrationError('invalid_webhook');
  return value as Record<string, unknown>;
}

export function text(value: unknown, maxLength = 1_024): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new TranscendIntegrationError('invalid_webhook');
  return value;
}
