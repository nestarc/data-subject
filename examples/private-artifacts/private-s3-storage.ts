import { createHash } from 'node:crypto';

import type { ArtifactStorage } from '../../src/storage/artifact-storage.interface';
import type { S3ObjectMetadata, S3Transport } from './s3-transport';

const OWNER = 'data-subject.private-artifacts.v1';
const DAY = 86_400_000;

export type ArtifactKind = 'export' | 'evidence';
export interface ArtifactIdentity {
  tenantId: string;
  requestId: string;
  kind: ArtifactKind;
}
export interface PrivateS3StorageOptions {
  bucket: string;
  /** A dedicated non-root prefix, for example privacy-artifacts/. */
  prefix: string;
  retentionDays: { export: number; evidence: number };
  /** Load the immutable request creation time from authoritative tenant-scoped storage. */
  createdAt: (identity: ArtifactIdentity) => Promise<Date>;
  transport: S3Transport;
  clock?: () => Date;
  /** Buffer-based ArtifactStorage is intended for bounded exports. */
  maxArtifactBytes?: number;
}
export interface CleanupResult {
  deleted: string[];
  skipped: string[];
  failed: Array<{ key: string; operation: 'inspect' | 'classify' | 'delete' }>;
}

/** Reference implementation for a private, never-versioned S3 bucket. */
export class PrivateS3ArtifactStorage implements ArtifactStorage {
  private readonly clock: () => Date;
  private readonly maxBytes: number;
  private ready?: Promise<void>;

  constructor(private readonly options: PrivateS3StorageOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket)) {
      throw new Error('Invalid artifact bucket');
    }
    if (!/^(?:[A-Za-z0-9_-]+\/)+$/.test(options.prefix)) {
      throw new Error('A dedicated artifact prefix is required');
    }
    for (const days of Object.values(options.retentionDays)) {
      if (!Number.isFinite(days) || days <= 0 || days > 36500) {
        throw new Error('Artifact retention must be between 0 and 36500 days');
      }
    }
    this.maxBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('maxArtifactBytes must be a positive integer');
    }
    this.clock = options.clock ?? (() => new Date());
  }

  /** Call at startup as well as relying on the automatic first-operation check. */
  async initialize(): Promise<void> {
    this.ready ??= this.checkBucket().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    const identity = parseArtifactKey(key);
    const expectedType = identity.kind === 'export' ? 'application/zip' : 'application/json';
    if (contentType !== expectedType || body.length > this.maxBytes) {
      throw new Error('Invalid artifact content type or size');
    }
    await this.initialize();
    const created = (await this.options.createdAt(identity)).getTime();
    const expiresAt = created + this.options.retentionDays[identity.kind] * DAY;
    if (!Number.isFinite(created) || created > this.now()) throw new Error('Invalid artifact creation time');
    if (expiresAt <= this.now()) throw new Error('Artifact has expired');
    const hash = digest(body);
    const input = this.objectInput(key);
    try {
      await this.options.transport.put({
        ...input,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
        ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64'),
        ServerSideEncryption: 'AES256',
        Metadata: {
          owner: OWNER,
          sha256: hash,
          'created-at': String(created),
          'expires-at': String(expiresAt),
        },
      });
    } catch (writeError) {
      // A lost response may still mean a successful upload. Never delete an
      // object after an ambiguous error: another worker may already reference it.
      let existing: S3ObjectMetadata | null;
      try {
        existing = await this.options.transport.head(input);
      } catch {
        throw writeError;
      }
      if (!existing) throw writeError;
      const metadata = inspectMetadata(existing);
      if (metadata.hash !== hash || existing.ContentType !== contentType || metadata.createdAt !== created) {
        throw new Error('Artifact key already contains different content');
      }
      if (metadata.expiresAt <= this.now()) throw new Error('Artifact has expired');
    }
    // This is an opaque locator, not a public or presigned download URL.
    return `s3://${this.options.bucket}/${input.Key}`;
  }

  async get(key: string, expectedHash?: string): Promise<{ body: Buffer; contentType: string } | null> {
    parseArtifactKey(key);
    await this.initialize();
    const input = this.objectInput(key);
    const head = await this.options.transport.head(input);
    if (!head) return null;
    const metadata = inspectMetadata(head);
    assertExpectedHash(metadata.hash, expectedHash);
    if (metadata.expiresAt <= this.now()) return null;
    if (!Number.isSafeInteger(head.ContentLength) || head.ContentLength! < 0 || head.ContentLength! > this.maxBytes) {
      throw new Error('Invalid artifact content length');
    }
    const object = await this.options.transport.get({ ...input, IfMatch: metadata.etag });
    const fetched = inspectMetadata(object);
    assertExpectedHash(fetched.hash, expectedHash);
    if (fetched.expiresAt <= this.now()) return null;
    if (object.body.length > this.maxBytes || digest(object.body) !== fetched.hash) {
      throw new Error('Artifact integrity check failed');
    }
    return { body: object.body, contentType: object.ContentType! };
  }

  /** Internal primitive. Route handlers should use AuthorizedArtifactDownloads. */
  async signDownload(key: string, seconds = 60, expectedHash?: string): Promise<string | null> {
    parseArtifactKey(key);
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) {
      throw new Error('Download links must expire in 1 to 300 seconds');
    }
    await this.initialize();
    const input = this.objectInput(key);
    const head = await this.options.transport.head(input);
    if (!head) return null;
    const metadata = inspectMetadata(head);
    assertExpectedHash(metadata.hash, expectedHash);
    const signingTime = this.now();
    const remaining = Math.floor((metadata.expiresAt - signingTime) / 1000);
    if (remaining < 1) return null;
    // SigV4 dates have second precision. Pin that date before credential resolution
    // so asynchronous signing cannot move the URL's absolute expiration forward.
    const signingDate = new Date(Math.floor(signingTime / 1000) * 1000);
    const expiresIn = Math.min(seconds, remaining);
    const expiresAt = signingDate.getTime() + expiresIn * 1000;
    const url = await this.options.transport.signGet(input, expiresIn, signingDate);
    return this.now() < expiresAt ? url : null;
  }

  /**
   * Run in a privileged job. Classification must use authoritative request state:
   * missing/failed alone does not prove abandonment (it may be awaiting retry).
   */
  async cleanup(options: {
    orphanGraceMs?: number;
    classify?: (identity: ArtifactIdentity) => Promise<'referenced' | 'active' | 'orphaned' | 'unknown'>;
  } = {}): Promise<CleanupResult> {
    const grace = options.orphanGraceMs ?? DAY;
    if (!Number.isFinite(grace) || grace < 300_000) {
      throw new Error('Orphan cleanup requires at least five minutes of grace');
    }
    await this.initialize();
    const result: CleanupResult = { deleted: [], skipped: [], failed: [] };
    const seen = new Set<string>();
    let token: string | undefined;
    do {
      const page = await this.options.transport.list({
        Bucket: this.options.bucket,
        Prefix: `${this.options.prefix}data-subject/`,
        ContinuationToken: token,
      });
      for (const fullKey of page.keys) {
        // Never trust a compatible provider's listing to enforce the prefix.
        if (!fullKey.startsWith(this.options.prefix)) {
          result.skipped.push(fullKey);
          continue;
        }
        const key = fullKey.slice(this.options.prefix.length);
        let identity: ArtifactIdentity;
        try { identity = parseArtifactKey(key); } catch {
          result.skipped.push(fullKey);
          continue;
        }
        let metadata: ReturnType<typeof inspectMetadata>;
        try {
          const head = await this.options.transport.head(this.objectInput(key));
          if (!head) { result.skipped.push(fullKey); continue; }
          metadata = inspectMetadata(head);
        } catch {
          result.failed.push({ key: fullKey, operation: 'inspect' });
          continue;
        }
        let shouldDelete = metadata.expiresAt <= this.now();
        if (!shouldDelete && options.classify && metadata.createdAt + grace <= this.now()) {
          try { shouldDelete = (await options.classify(identity)) === 'orphaned'; } catch {
            result.failed.push({ key: fullKey, operation: 'classify' });
            continue;
          }
        }
        if (!shouldDelete) { result.skipped.push(fullKey); continue; }
        try {
          await this.options.transport.delete({ ...this.objectInput(key), IfMatch: metadata.etag });
          result.deleted.push(fullKey);
        } catch {
          // Includes conditional-delete races. Report and inspect again next run.
          result.failed.push({ key: fullKey, operation: 'delete' });
        }
      }
      token = page.nextToken;
      if (token && seen.has(token)) throw new Error('Artifact listing repeated a continuation token');
      if (token) seen.add(token);
    } while (token);
    return result;
  }

  private objectInput(key: string) {
    return { Bucket: this.options.bucket, Key: `${this.options.prefix}${key}` };
  }

  private now(): number {
    const time = this.clock().getTime();
    if (!Number.isFinite(time)) throw new Error('Invalid artifact clock');
    return time;
  }

  private async checkBucket(): Promise<void> {
    const state = await this.options.transport.inspectBucket(this.options.bucket);
    if (!state.publicAccessBlocked || !state.aclDisabled || state.versioning !== 'disabled') {
      throw new Error('Artifact bucket must block public access, disable ACLs, and never enable versioning');
    }
  }
}

export function parseArtifactKey(key: string): ArtifactIdentity {
  const match = /^data-subject\/([^/]+)\/([^/]+)\/(export\.zip|erase-evidence\.json)$/.exec(key);
  if (!match) throw new Error('Invalid artifact key');
  const decode = (part: string) => {
    const value = decodeURIComponent(part);
    const canonical = value === '.' || value === '..'
      ? value.replace(/\./g, '%2E') : encodeURIComponent(value);
    if (!value.trim() || part !== canonical) throw new Error('Invalid artifact key segment');
    return value;
  };
  return { tenantId: decode(match[1]), requestId: decode(match[2]), kind: match[3] === 'export.zip' ? 'export' : 'evidence' };
}

function digest(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function assertExpectedHash(hash: string, expected?: string): void {
  if (expected !== undefined && hash !== expected) throw new Error('Artifact does not match request');
}

function inspectMetadata(object: S3ObjectMetadata) {
  const metadata = object.Metadata ?? {};
  const createdAt = Number(metadata['created-at']);
  const expiresAt = Number(metadata['expires-at']);
  if (metadata.owner !== OWNER || !/^[0-9a-f]{64}$/.test(metadata.sha256 ?? '') ||
      !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt ||
      !object.ETag || !['application/zip', 'application/json'].includes(object.ContentType ?? '')) {
    throw new Error('Artifact metadata is missing or invalid');
  }
  return { hash: metadata.sha256, createdAt, expiresAt, etag: object.ETag };
}
