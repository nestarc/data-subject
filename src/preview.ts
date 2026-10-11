import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import type { ErasurePlanSummary } from './erasure-plan';
import { DataSubjectError, DataSubjectErrorCode } from './errors';
import { stableStringify } from './stable-json';

export interface ErasurePreview {
  schemaVersion: 'data-subject.preview.v1';
  subjectId: string;
  tenantId: string;
  issuedAt: string;
  expiresAt: string;
  plan: ErasurePlanSummary;
  signature: string;
}

/** A shared key is required when previews cross processes; ephemeral by default. */
export class PreviewSigner {
  private readonly key: Buffer;

  constructor(key?: Buffer | string) {
    this.key = key === undefined ? randomBytes(32) : Buffer.from(key);
    if (this.key.length < 32) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidInput,
        'previewSigningKey requires at least 32 bytes',
      );
    }
  }

  issue(
    plan: ErasurePlanSummary,
    subjectId: string,
    tenantId: string,
    now: Date,
    ttlMs: number,
  ): ErasurePreview {
    if (
      !Number.isFinite(ttlMs) ||
      ttlMs <= 0 ||
      ttlMs > 3_600_000 ||
      !Number.isFinite(now.getTime())
    ) {
      throw new DataSubjectError(
        DataSubjectErrorCode.InvalidInput,
        'preview TTL must be within one hour',
      );
    }
    const payload = {
      schemaVersion: 'data-subject.preview.v1' as const,
      subjectId,
      tenantId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      plan,
    };
    return { ...payload, signature: this.sign(payload) };
  }

  verify(
    preview: ErasurePreview,
    subjectId: string,
    tenantId: string,
    now: Date,
  ): ErasurePlanSummary {
    if (
      !preview ||
      preview.schemaVersion !== 'data-subject.preview.v1' ||
      preview.subjectId !== subjectId ||
      preview.tenantId !== tenantId ||
      typeof preview.signature !== 'string' ||
      !/^[a-f0-9]{64}$/.test(preview.signature)
    ) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch);
    }
    const { signature, ...payload } = preview;
    let expected: Buffer;
    try {
      expected = Buffer.from(this.sign(payload), 'hex');
    } catch {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch);
    }
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanMismatch);
    }
    const issued = Date.parse(preview.issuedAt);
    const expires = Date.parse(preview.expiresAt);
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(now.getTime()) ||
      issued > now.getTime() ||
      expires <= now.getTime() ||
      expires <= issued ||
      expires - issued > 3_600_000
    ) {
      throw new DataSubjectError(DataSubjectErrorCode.PlanExpired);
    }
    return preview.plan;
  }

  private sign(payload: unknown): string {
    return createHmac('sha256', this.key).update(stableStringify(payload)).digest('hex');
  }
}
