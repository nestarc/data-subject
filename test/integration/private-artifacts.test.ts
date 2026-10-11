import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import { AuthorizedArtifactDownloads, VerifiedArtifactActor } from '../../examples/private-artifacts/authorized-downloads';
import { PrivateS3ArtifactStorage } from '../../examples/private-artifacts/private-s3-storage';
import type { S3ObjectMetadata, S3Transport } from '../../examples/private-artifacts/s3-transport';
import { exportArtifactKey, erasureEvidenceArtifactKey } from '../../src/artifacts';
import type { DataSubjectRequest } from '../../src/types';

const DAY = 86_400_000;
const exportKey = exportArtifactKey('tenant-a', 'request-a');
const evidenceKey = erasureEvidenceArtifactKey('tenant-a', 'request-a');
const body = Buffer.from('private payload');
const hash = createHash('sha256').update(body).digest('hex');
type PutInput = Parameters<S3Transport['put']>[0];

class FakeS3 implements S3Transport {
  readonly objects = new Map<string, S3ObjectMetadata & { body: Buffer }>();
  readonly puts: PutInput[] = [];
  readonly deletes: Array<Parameters<S3Transport['delete']>[0]> = [];
  readonly signs: Array<{ key: string; seconds: number }> = [];
  unsafe = false;
  versioning: 'disabled' | 'enabled' | 'suspended' = 'disabled';
  losePutResponse = false;
  failPut = false;
  failDelete = false;
  failHead = false;
  failList = false;
  extraKeys: string[] = [];
  pageSize = 2;
  private listedKeys: string[] = [];

  async inspectBucket() {
    return { publicAccessBlocked: !this.unsafe, aclDisabled: true, versioning: this.versioning };
  }
  async put(input: PutInput) {
    this.puts.push(input);
    if (this.failPut) throw new Error('upload unavailable');
    if (this.objects.has(input.Key)) throw new Error('precondition failed');
    this.objects.set(input.Key, {
      body: Buffer.from(input.Body), ContentType: input.ContentType,
      Metadata: { ...input.Metadata }, ContentLength: input.Body.length,
      ETag: `"${createHash('md5').update(input.Body).digest('hex')}"`,
    });
    if (this.losePutResponse) throw new Error('response lost');
  }
  async head(input: Parameters<S3Transport['head']>[0]) {
    if (this.failHead) throw new Error('head unavailable');
    return this.objects.get(input.Key) ?? null;
  }
  async get(input: Parameters<S3Transport['get']>[0]) {
    const object = this.objects.get(input.Key);
    if (!object || object.ETag !== input.IfMatch) throw new Error('precondition failed');
    return { ...object, body: Buffer.from(object.body) };
  }
  async list(input: Parameters<S3Transport['list']>[0]) {
    if (this.failList) throw new Error('listing unavailable');
    if (input.ContinuationToken === undefined) {
      this.listedKeys = [...Array.from(this.objects.keys()).filter((key) => key.startsWith(input.Prefix)), ...this.extraKeys];
    }
    const keys = this.listedKeys;
    const start = Number(input.ContinuationToken ?? '0');
    return { keys: keys.slice(start, start + this.pageSize), nextToken: start + this.pageSize < keys.length ? String(start + this.pageSize) : undefined };
  }
  async delete(input: Parameters<S3Transport['delete']>[0]) {
    this.deletes.push(input);
    if (this.failDelete) throw new Error('delete unavailable');
    const object = this.objects.get(input.Key);
    if (!object || object.ETag !== input.IfMatch) throw new Error('precondition failed');
    this.objects.delete(input.Key);
  }
  async signGet(input: Parameters<S3Transport['signGet']>[0], seconds: number, _signingDate: Date) {
    this.signs.push({ key: input.Key, seconds });
    return `https://signed.invalid/${input.Key}?expires=${seconds}`;
  }
}

function fixture() {
  const transport = new FakeS3();
  let now = Date.parse('2026-10-11T00:00:00Z');
  const storage = new PrivateS3ArtifactStorage({
    transport, bucket: 'private-artifact-bucket', prefix: 'privacy/',
    retentionDays: { export: 1, evidence: 30 }, clock: () => new Date(now),
    createdAt: async () => new Date('2026-10-11T00:00:00Z'),
  });
  return { transport, storage, advance: (ms: number) => { now += ms; } };
}

describe('private S3 artifact example', () => {
  it('uploads immutably with checksums, private locators, and independent retention', async () => {
    const { storage, transport } = fixture();
    await expect(storage.put(exportKey, body, 'application/zip')).resolves.toBe(`s3://private-artifact-bucket/privacy/${exportKey}`);
    await storage.put(evidenceKey, body, 'application/json');
    expect(transport.puts[0]).toMatchObject({ IfNoneMatch: '*', ServerSideEncryption: 'AES256', ChecksumSHA256: Buffer.from(hash, 'hex').toString('base64') });
    expect(transport.puts[0]).not.toHaveProperty('ACL');
    const [exp, ev] = transport.puts.map((p) => Number(p.Metadata['expires-at']) - Number(p.Metadata['created-at']));
    expect(exp).toBe(DAY);
    expect(ev).toBe(30 * DAY);
    await expect(storage.get(exportKey)).resolves.toEqual({ body, contentType: 'application/zip' });
  });

  it('reconciles a lost response and identical retry without extending retention', async () => {
    const { storage, transport, advance } = fixture();
    transport.losePutResponse = true;
    await storage.put(exportKey, body, 'application/zip');
    const expiry = transport.objects.get(`privacy/${exportKey}`)!.Metadata!['expires-at'];
    advance(1000);
    await storage.put(exportKey, body, 'application/zip');
    expect(transport.objects.get(`privacy/${exportKey}`)!.Metadata!['expires-at']).toBe(expiry);
    await expect(storage.put(exportKey, Buffer.from('different'), 'application/zip')).rejects.toThrow('different content');
    expect(transport.deletes).toHaveLength(0);
  });

  it('preserves failed/ambiguous uploads for a safe retry', async () => {
    const { storage, transport } = fixture();
    transport.failPut = true;
    await expect(storage.put(exportKey, body, 'application/zip')).rejects.toThrow('upload unavailable');
    expect(transport.objects.size).toBe(0);
    transport.failPut = false;
    transport.losePutResponse = true;
    transport.failHead = true;
    await expect(storage.put(exportKey, body, 'application/zip')).rejects.toThrow('response lost');
    expect(transport.objects.size).toBe(1);
    transport.failHead = false;
    await expect(storage.put(exportKey, body, 'application/zip')).resolves.toContain('s3://');
  });

  it('denies expired reads and links before a janitor runs and does not revive an expired retry', async () => {
    const { storage, transport, advance } = fixture();
    await storage.put(exportKey, body, 'application/zip');
    advance(DAY - 20_000);
    await storage.signDownload(exportKey, 60);
    expect(transport.signs[0].seconds).toBe(20);
    advance(20_000);
    await expect(storage.get(exportKey)).resolves.toBeNull();
    await expect(storage.signDownload(exportKey)).resolves.toBeNull();
    await expect(storage.put(exportKey, body, 'application/zip')).rejects.toThrow('expired');
    expect(transport.signs).toHaveLength(1);
    await storage.cleanup();
    expect(transport.objects.size).toBe(0);
    await expect(storage.put(exportKey, body, 'application/zip')).rejects.toThrow('expired');
  });

  it('cleans expired exports while retaining evidence and reports deletion errors for retry', async () => {
    const { storage, transport, advance } = fixture();
    await storage.put(exportKey, body, 'application/zip');
    await storage.put(evidenceKey, body, 'application/json');
    advance(DAY);
    transport.failDelete = true;
    expect((await storage.cleanup()).failed).toEqual([{ key: `privacy/${exportKey}`, operation: 'delete' }]);
    transport.failDelete = false;
    expect((await storage.cleanup()).deleted).toEqual([`privacy/${exportKey}`]);
    expect(transport.objects.has(`privacy/${evidenceKey}`)).toBe(true);
    expect(transport.deletes[0].IfMatch).toBeDefined();
  });

  it('cleans only definitively abandoned uploads after grace and keeps active/unknown artifacts', async () => {
    const { storage, transport, advance } = fixture();
    const keys = ['orphan', 'active', 'unknown', 'referenced', 'failed-read'].map((id) => exportArtifactKey('tenant-a', id));
    for (const key of keys) await storage.put(key, body, 'application/zip');
    const classify = jest.fn(async ({ requestId }: { requestId: string }) => {
      if (requestId === 'failed-read') throw new Error('database unavailable');
      return requestId === 'orphan' ? 'orphaned' as const : requestId as 'active' | 'unknown' | 'referenced';
    });
    expect((await storage.cleanup({ orphanGraceMs: 300_000, classify })).deleted).toHaveLength(0);
    expect(classify).not.toHaveBeenCalled();
    advance(300_000);
    const result = await storage.cleanup({ orphanGraceMs: 300_000, classify });
    expect(result.deleted).toEqual([`privacy/${keys[0]}`]);
    expect(result.failed).toEqual([{ key: `privacy/${keys[4]}`, operation: 'classify' }]);
    expect(transport.objects.size).toBe(4);
  });

  it('follows all cleanup pages while deleting expired objects', async () => {
    const { storage, transport, advance } = fixture();
    for (let i = 0; i < 5; i++) await storage.put(exportArtifactKey('tenant-a', `request-${i}`), body, 'application/zip');
    advance(DAY);
    const result = await storage.cleanup();
    expect(result.deleted).toHaveLength(5);
    expect(transport.objects.size).toBe(0);
  });

  it('never deletes outside its namespace or objects lacking owned metadata', async () => {
    const { storage, transport, advance } = fixture();
    await storage.put(exportKey, body, 'application/zip');
    const object = transport.objects.get(`privacy/${exportKey}`)!;
    transport.objects.set('privacy/data-subject/tenant-a/unowned/export.zip', { ...object, Metadata: {} });
    transport.extraKeys = ['other/data-subject/tenant-a/secret/export.zip', 'privacy/data-subject/../secret/export.zip'];
    transport.pageSize = 100;
    advance(DAY);
    const result = await storage.cleanup();
    expect(result.deleted).toEqual([`privacy/${exportKey}`]);
    expect(result.failed).toEqual([{ key: 'privacy/data-subject/tenant-a/unowned/export.zip', operation: 'inspect' }]);
    expect(result.skipped).toEqual(transport.extraKeys);
  });

  it.each(['enabled', 'suspended'] as const)('rejects a %s versioned bucket before any upload', async (versioning) => {
    const { storage, transport } = fixture();
    transport.versioning = versioning;
    await expect(storage.put(exportKey, body, 'application/zip')).rejects.toThrow('never enable versioning');
    expect(transport.puts).toHaveLength(0);
  });

  it('rejects public buckets, unsafe keys/types/link lifetimes, and integrity mismatches', async () => {
    const { storage, transport } = fixture();
    transport.unsafe = true;
    await expect(storage.initialize()).rejects.toThrow('block public access');
    transport.unsafe = false;
    await storage.initialize();
    for (const key of ['data-subject/../id/export.zip', 'data-subject/a/b/other.json', 'data-subject/%61/b/export.zip']) {
      await expect(storage.put(key, body, 'application/zip')).rejects.toThrow('Invalid artifact');
    }
    await expect(storage.put(exportKey, body, 'text/html')).rejects.toThrow('content type');
    await expect(storage.signDownload(exportKey, 301)).rejects.toThrow('1 to 300');
    await storage.put(exportKey, body, 'application/zip');
    await expect(storage.get(exportKey, 'other-hash')).rejects.toThrow('does not match request');
    transport.objects.get(`privacy/${exportKey}`)!.body = Buffer.from('tampered');
    await expect(storage.get(exportKey)).rejects.toThrow('integrity');
  });

  it('supports canonical encoded IDs without interpreting them as paths', async () => {
    const { storage } = fixture();
    const key = exportArtifactKey('tenant/a', '..');
    await storage.put(key, body, 'application/zip');
    await expect(storage.get(key)).resolves.toMatchObject({ body });
  });

  it('propagates listing failure instead of reporting successful cleanup', async () => {
    const { storage, transport } = fixture();
    transport.failList = true;
    await expect(storage.cleanup()).rejects.toThrow('listing unavailable');
  });
});

describe('authenticated artifact delivery', () => {
  const actor: VerifiedArtifactActor = { actorId: 'actor-a', tenantId: 'tenant-a', subjectId: 'subject-a', permissions: ['export:download'] };
  const request = {
    id: 'request-a', tenantId: 'tenant-a', subjectId: 'subject-a', type: 'export',
    state: 'completed', artifactHash: hash, artifactUrl: 'https://untrusted.invalid/other-tenant',
  } as DataSubjectRequest;

  it('uses the tenant-scoped lookup and verified subject, never a persisted public URL', async () => {
    const { storage, transport } = fixture();
    await storage.put(exportKey, body, 'application/zip');
    const getRequest = jest.fn(async () => request);
    const downloads = new AuthorizedArtifactDownloads({ getRequest }, storage);
    await expect(downloads.download('request-a', actor)).resolves.toMatchObject({ body });
    await expect(downloads.link('request-a', actor)).resolves.toContain(`privacy/${exportKey}`);
    expect(getRequest).toHaveBeenCalledWith('request-a', 'tenant-a');
    expect(transport.signs).toEqual([{ key: `privacy/${exportKey}`, seconds: 60 }]);
  });

  it.each([
    { tenantId: 'tenant-b' }, { subjectId: 'subject-b' }, { permissions: [] }, { actorId: '' },
  ])('rejects an unauthorized actor %j before signing', async (patch) => {
    const { storage, transport } = fixture();
    const downloads = new AuthorizedArtifactDownloads({ getRequest: async () => request }, storage);
    await expect(downloads.link('request-a', { ...actor, ...patch })).rejects.toThrow('not available');
    expect(transport.signs).toHaveLength(0);
  });

  it('requires separate evidence permission and completed state', async () => {
    const { storage } = fixture();
    const evidence = new AuthorizedArtifactDownloads({ getRequest: async () => ({ ...request, type: 'erase' }) }, storage);
    await expect(evidence.link('request-a', actor)).rejects.toThrow('not available');
    const unfinished = new AuthorizedArtifactDownloads({ getRequest: async () => ({ ...request, state: 'failed' }) }, storage);
    await expect(unfinished.link('request-a', actor)).rejects.toThrow('not available');
  });
});

describe('AWS SDK v3 command bridge', () => {
  type Command = { operation: string; input: Record<string, unknown> };
  type SigningOptions = { expiresIn: number; signingDate: Date };
  const sdk = Object.fromEntries([
    'GetPublicAccessBlock', 'GetBucketOwnershipControls', 'GetBucketVersioning',
    'PutObject', 'HeadObject', 'GetObject', 'ListObjectsV2', 'DeleteObject',
  ].map((operation) => [`${operation}Command`, class {
    operation = operation;
    constructor(readonly input: Record<string, unknown>) {}
  }]));
  const { createAwsS3Transport } = createRequire(__filename)('../../examples/private-artifacts/aws-sdk-v3.cjs') as {
    createAwsS3Transport(options: { sdk: typeof sdk; client: { send: (command: Command) => Promise<unknown> }; getSignedUrl: (client: unknown, command: Command, options: SigningOptions) => Promise<string> }): S3Transport;
  };

  it('maps real S3 command shapes, streams, headers, and signing options', async () => {
    const sent: Command[] = [];
    const client = { send: jest.fn(async (command: Command) => {
      sent.push(command);
      if (command.operation === 'GetPublicAccessBlock') return { PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true } };
      if (command.operation === 'GetBucketOwnershipControls') return { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } };
      if (command.operation === 'GetObject') return { Body: { transformToByteArray: async () => body } };
      if (command.operation === 'HeadObject') throw { $metadata: { httpStatusCode: 404 } };
      if (command.operation === 'ListObjectsV2') return { Contents: [{ Key: 'key-a' }], IsTruncated: true, NextContinuationToken: 'next' };
      return {};
    }) };
    const getSignedUrl = jest.fn(async () => 'https://signed.invalid');
    const transport = createAwsS3Transport({ client, sdk, getSignedUrl });
    await expect(transport.inspectBucket('bucket')).resolves.toEqual({ publicAccessBlocked: true, aclDisabled: true, versioning: 'disabled' });
    await expect(transport.head({ Bucket: 'bucket', Key: 'key' })).resolves.toBeNull();
    await expect(transport.get({ Bucket: 'bucket', Key: 'key', IfMatch: 'etag' })).resolves.toMatchObject({ body });
    await expect(transport.list({ Bucket: 'bucket', Prefix: 'prefix/' })).resolves.toEqual({ keys: ['key-a'], nextToken: 'next' });
    await transport.delete({ Bucket: 'bucket', Key: 'key', IfMatch: 'etag' });
    const signingDate = new Date('2026-10-11T00:00:00Z');
    await transport.signGet({ Bucket: 'bucket', Key: 'key' }, 30, signingDate);
    expect(sent.find((command) => command.operation === 'DeleteObject')!.input.IfMatch).toBe('etag');
    expect(getSignedUrl).toHaveBeenCalledWith(client, expect.objectContaining({ operation: 'GetObject' }), { expiresIn: 30, signingDate });
  });

  it.each([
    { name: 'caps delayed signing to retention with fractional seconds', remainingMs: 60_750, seconds: 300, delayMs: 10_000, expectedTtl: 60, available: true },
    { name: 'preserves a shorter requested lifetime during signing delay', remainingMs: 120_750, seconds: 30, delayMs: 10_000, expectedTtl: 30, available: true },
    { name: 'withholds a link when signing finishes after artifact expiry', remainingMs: 1_000, seconds: 60, delayMs: 10_000, expectedTtl: 1, available: false },
    { name: 'withholds a link when its shorter lifetime expires during signing', remainingMs: 120_000, seconds: 1, delayMs: 2_000, expectedTtl: 1, available: false },
  ])('$name', async ({ remainingMs, seconds, delayMs, expectedTtl, available }) => {
    const { storage, transport, advance } = fixture();
    await storage.put(exportKey, body, 'application/zip');
    const artifactExpiresAt = Number(transport.puts[0].Metadata['expires-at']);
    advance(DAY - remainingMs);
    const startedAt = artifactExpiresAt - remainingMs;
    let signedExpiresAt = 0;
    const getSignedUrl = jest.fn(async (_client: unknown, _command: Command, options: SigningOptions) => {
      // Credential/endpoint resolution can finish well after signDownload starts.
      await Promise.resolve();
      advance(delayMs);
      const signingDate = options.signingDate ?? new Date(startedAt + delayMs);
      signedExpiresAt = Math.floor(signingDate.getTime() / 1000) * 1000 + options.expiresIn * 1000;
      return `https://signed.invalid/?expiresAt=${signedExpiresAt}`;
    });
    const client = { send: async () => ({}) };
    transport.signGet = createAwsS3Transport({ client, sdk, getSignedUrl }).signGet;

    const url = await storage.signDownload(exportKey, seconds);
    expect(getSignedUrl).toHaveBeenCalledWith(client, expect.objectContaining({ operation: 'GetObject' }), {
      expiresIn: expectedTtl,
      signingDate: new Date(Math.floor(startedAt / 1000) * 1000),
    });
    expect(signedExpiresAt).toBeLessThanOrEqual(artifactExpiresAt);
    expect(signedExpiresAt).toBeLessThanOrEqual(startedAt + seconds * 1000);
    if (available) expect(url).toBe(`https://signed.invalid/?expiresAt=${signedExpiresAt}`);
    else expect(url).toBeNull();
  });
});
