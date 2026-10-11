import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer } from 'node:http';

import { DataSubjectPersistenceError } from '../../src/errors';
import type { DurableJobStore, JobRecord, JobStepResult } from '../../src/jobs/types';
import {
  TranscendErasureAdapter,
  TranscendIntegrationError,
  type TranscendAdapterOptions,
  type TranscendBinding,
} from '../../src/integrations/transcend';
import type { DataSubjectRequest } from '../../src/types';

const keys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const otherKeys = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const now = new Date('2026-10-11T00:00:00.000Z');
const seconds = now.getTime() / 1000;
const secret = 'synthetic-webhook-secret-32-characters';
const encryptionKey = randomBytes(32);
const localHttpTest = process.env.DATA_SUBJECT_HTTP_FIXTURE === '1' ? test : test.skip;

function jwt(
  claims: Record<string, unknown> = {},
  algorithm = 'ES384',
  key = keys.privateKey,
): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      scope: 'coreIdentifier',
      aud: 'synthetic-audience',
      exp: seconds + 60,
      iat: seconds - 1,
      ...claims,
    }),
  ).toString('base64url');
  return `${header}.${payload}.${sign('sha384', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}

function webhook() {
  return {
    type: 'ERASURE',
    coreIdentifier: { value: 'synthetic@example.invalid' },
    dataSubject: { type: 'customer' },
    isTest: false,
    extras: {
      organization: { id: 'organization' },
      dataSilo: { id: 'silo' },
      request: { id: 'provider-request', link: 'http://169.254.169.254/private' },
      profile: {
        id: 'profile',
        RequestDataSiloId: 'request-silo',
        identifier: 'synthetic@example.invalid',
        type: 'email',
      },
    },
  };
}

function incoming(body: unknown = webhook(), token = jwt()) {
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: {
      'x-sombra-token': token,
      'x-transcend-nonce': 'synthetic-nonce',
      'x-data-subject-webhook-secret': secret,
    } as Record<string, string | string[] | undefined>,
  };
}

function local(overrides: Partial<DataSubjectRequest> = {}): DataSubjectRequest {
  return {
    id: 'local-request',
    tenantId: 'trusted-tenant',
    subjectId: 'trusted-subject',
    type: 'erase',
    state: 'completed',
    createdAt: now,
    dueAt: now,
    completedAt: now,
    failedAt: null,
    failureReason: null,
    artifactHash: 'hash',
    artifactUrl: 'private://artifact',
    stats: { entities: [], lifecycle: { dataOutcome: 'completed' } },
    requestedBy: 'transcend:production',
    ...overrides,
  };
}

/** Contract fake; PostgreSQL queue persistence/concurrency is exercised separately. */
function fixture() {
  const records = new Map<string, JobRecord>();
  const jobs: Pick<DurableJobStore, 'submit' | 'get'> = {
    get: jest.fn(async (id, tenantId) => {
      const record = records.get(id);
      return record?.tenantId === tenantId ? structuredClone(record) : null;
    }),
    submit: jest.fn(async (input) => {
      if (records.has(input.id)) throw new Error('unique conflict');
      const job: JobRecord = {
        ...input,
        payloadHash: 'test-only',
        state: 'queued',
        checkpoint: null,
        result: null,
        processedRows: 0,
        pagesCommitted: 0,
        chunksWritten: 0,
        attempts: 0,
        revision: 0,
        hasCommittedChanges: false,
        partial: false,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        availableAt: now,
        completedAt: null,
        chunksDeletedAt: null,
        expiresAt: new Date(now.getTime() + 86_400_000),
        purgedAt: null,
      };
      records.set(job.id, structuredClone(job));
      return { job, created: true };
    }),
  };
  const service = {
    erase: jest.fn(async () => local()),
    getRequest: jest.fn(async () => local()),
    retryCompletion: jest.fn(async () => local()),
  };
  const http = jest.fn(async () => ({ status: 200 }));
  const binding: TranscendBinding = {
    id: 'production',
    organizationId: 'organization',
    dataSiloId: 'silo',
    tenantId: 'trusted-tenant',
    audience: 'synthetic-audience',
    publicKeys: [keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()],
    webhookSecret: secret,
    sombraOrigin: 'https://synthetic.sombra.example.invalid',
    apiKey: 'synthetic-api-key',
    identifierType: 'email',
    dataSubjectType: 'customer',
    resolveSubject: jest.fn(async () => 'trusted-subject'),
  };
  const options: TranscendAdapterOptions = {
    jobs,
    service,
    bindings: [binding],
    nonceEncryptionKey: encryptionKey,
    clock: () => now,
    http,
  };
  return {
    adapter: new TranscendErasureAdapter(options),
    options,
    binding,
    jobs,
    service,
    http,
    records,
  };
}

function advance(job: JobRecord, step: JobStepResult): JobRecord {
  return {
    ...job,
    checkpoint: step.checkpoint,
    result: step.result ?? job.result,
    state: step.done ? 'completed' : 'queued',
  };
}

async function runLocal(adapter: TranscendErasureAdapter, job: JobRecord): Promise<JobStepResult> {
  const fenced = advance(job, await adapter.processStep({ job }));
  return adapter.processStep({ job: fenced });
}

describe('Transcend erasure adapter', () => {
  test('accepts a verified receipt, encrypts nonce, and only uses a trusted tenant/subject mapping', async () => {
    const f = fixture();
    const body = { ...webhook(), tenantId: 'attacker-tenant', subjectId: 'attacker-subject' };
    const { job, created } = await f.adapter.receive(incoming(body));
    expect(created).toBe(true);
    expect(job.tenantId).toBe('trusted-tenant');
    expect(job.payload).toMatchObject({ subjectId: 'trusted-subject', bindingId: 'production' });
    expect(JSON.stringify(job)).not.toContain('synthetic-nonce');
    expect(JSON.stringify(job)).not.toContain('synthetic@example.invalid');
    expect(JSON.stringify(job)).not.toContain(secret);
    expect(f.service.erase).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  test('replay after deletion does not resolve the now-missing subject or submit another job', async () => {
    const f = fixture();
    const first = await f.adapter.receive(incoming());
    f.binding.resolveSubject = jest.fn(async () => null);
    const restarted = new TranscendErasureAdapter(f.options);
    const replay = incoming();
    replay.headers['x-transcend-nonce'] = 'fresh-provider-nonce';
    expect(await restarted.receive(replay)).toMatchObject({
      created: false,
      job: { id: first.job.id },
    });
    expect(f.binding.resolveSubject).not.toHaveBeenCalled();
    expect(f.jobs.submit).toHaveBeenCalledTimes(1);
  });

  test('concurrent identical receipts converge despite randomized encrypted nonce', async () => {
    const f = fixture();
    const result = await Promise.all(
      Array.from({ length: 5 }, () => f.adapter.receive(incoming())),
    );
    expect(result.filter((item) => item.created)).toHaveLength(1);
    expect(new Set(result.map((item) => item.job.id)).size).toBe(1);
    expect(f.records.size).toBe(1);
  });

  test('a changed subject for the same provider identity is not a replay', async () => {
    const f = fixture();
    await f.adapter.receive(incoming());
    const changed = webhook();
    changed.extras.profile.identifier = 'different@example.invalid';
    await expect(f.adapter.receive(incoming(changed))).rejects.toMatchObject({
      code: 'invalid_webhook',
    });
    expect(f.records.size).toBe(1);
  });

  test.each([
    ['invalid signature', jwt({}, 'ES384', otherKeys.privateKey)],
    ['wrong algorithm', jwt({}, 'HS384')],
    ['expired', jwt({ exp: seconds })],
    ['future nbf', jwt({ nbf: seconds + 1 })],
    ['future iat', jwt({ iat: seconds + 1 })],
    ['wrong scope', jwt({ scope: 'session' })],
    ['wrong audience', jwt({ aud: 'another-audience' })],
    ['malformed exp', jwt({ exp: 'tomorrow' })],
    ['malformed token', 'malformed'],
  ])('rejects %s before queue or local execution', async (_name, token) => {
    const f = fixture();
    await expect(f.adapter.receive(incoming(webhook(), token))).rejects.toMatchObject({
      code: 'unauthorized_webhook',
    });
    expect(f.jobs.submit).not.toHaveBeenCalled();
    expect(f.service.erase).not.toHaveBeenCalled();
  });

  test('matches provider JWT contract when optional time claims are absent and accepts exact array audience', async () => {
    const f = fixture();
    const token = jwt({ exp: undefined, iat: undefined, aud: ['other', 'synthetic-audience'] });
    expect((await f.adapter.receive(incoming(webhook(), token))).created).toBe(true);
  });

  test('rejects missing or duplicate auth headers and incorrect custom secret', async () => {
    const f = fixture();
    for (const headers of [
      { 'x-sombra-token': undefined },
      { 'x-sombra-token': [jwt(), jwt()] },
      { 'X-Sombra-Token': jwt() },
      { 'x-data-subject-webhook-secret': 'wrong' },
    ]) {
      const input = incoming();
      Object.assign(input.headers, headers);
      await expect(f.adapter.receive(input)).rejects.toBeInstanceOf(TranscendIntegrationError);
    }
    expect(f.jobs.submit).not.toHaveBeenCalled();
  });

  test.each(['ACCESS', 'unknown-type'])('does not silently accept unsupported %s', async (type) => {
    const f = fixture();
    await expect(f.adapter.receive(incoming({ ...webhook(), type }))).rejects.toMatchObject({
      code: 'unsupported_request',
    });
  });

  test('rejects malformed, overlarge, unexpected binding, and production test requests', async () => {
    const f = fixture();
    await expect(
      f.adapter.receive({ ...incoming(), body: Buffer.from('{') }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    await expect(
      f.adapter.receive({ ...incoming(), body: Buffer.alloc(65_537) }),
    ).rejects.toMatchObject({ code: 'invalid_webhook' });
    await expect(f.adapter.receive(incoming({ extras: null }))).rejects.toMatchObject({
      code: 'invalid_webhook',
    });
    await expect(f.adapter.receive(incoming({ ...webhook(), isTest: true }))).rejects.toMatchObject(
      { code: 'unsupported_request' },
    );
    const wrong = webhook();
    wrong.extras.organization.id = 'unknown-organization';
    await expect(f.adapter.receive(incoming(wrong))).rejects.toMatchObject({
      code: 'unauthorized_webhook',
    });
  });

  test('fails closed for an unresolved local subject', async () => {
    const f = fixture();
    const adapter = new TranscendErasureAdapter({
      ...f.options,
      bindings: [{ ...f.binding, resolveSubject: async () => null }],
    });
    await expect(adapter.receive(incoming())).rejects.toMatchObject({ code: 'subject_not_mapped' });
    expect(f.jobs.submit).not.toHaveBeenCalled();
  });

  test('separates committed local completion from accepted provider callback and retries only the callback', async () => {
    const f = fixture();
    const { job } = await f.adapter.receive(incoming());
    const localStep = await runLocal(f.adapter, job);
    expect(localStep).toMatchObject({
      done: false,
      result: { localStatus: 'completed', providerStatus: 'pending' },
    });
    const pending = advance(job, localStep);
    f.http.mockResolvedValueOnce({ status: 503 });
    await expect(f.adapter.processStep({ job: pending })).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    const restarted = new TranscendErasureAdapter(f.options);
    const callbackStep = await restarted.processStep({ job: pending });
    expect(callbackStep).toMatchObject({
      done: true,
      result: { localStatus: 'completed', providerStatus: 'accepted', providerHttpStatus: 200 },
    });
    expect(f.service.erase).toHaveBeenCalledTimes(1);
    expect(f.service.erase).toHaveBeenCalledWith('trusted-subject', 'trusted-tenant', {
      requestedBy: 'transcend:production',
      requestKey: job.id,
    });
    expect(f.http).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'https://synthetic.sombra.example.invalid/v1/data-silo',
        method: 'PUT',
        body: '{}',
        redirect: 'error',
        headers: expect.objectContaining({ 'x-transcend-nonce': 'synthetic-nonce' }),
      }),
    );
  });

  test('commits a conservative execution fence before the independently committed local call', async () => {
    const f = fixture();
    const { job } = await f.adapter.receive(incoming());
    const fence = await f.adapter.processStep({ job });
    expect(fence).toMatchObject({
      done: false,
      hasCommittedChanges: true,
      checkpoint: { phase: 'local_execution', localRequestId: null },
      result: { localStatus: 'unknown', dataOutcome: 'unknown', requiresReconciliation: true },
    });
    expect(f.service.erase).not.toHaveBeenCalled();
    // Simulate losing the post-erasure queue checkpoint: resume the persisted fence.
    const persistedFence = advance(job, fence);
    await f.adapter.processStep({ job: persistedFence });
    await f.adapter.processStep({ job: persistedFence });
    expect(f.service.erase).toHaveBeenCalledTimes(2);
    expect(f.service.erase.mock.calls[0]).toEqual(f.service.erase.mock.calls[1]);
    expect(f.http).not.toHaveBeenCalled();
  });

  test.each([400, 401, 403, 409, 413, 302])(
    'records HTTP %s as rejection requiring reconciliation, never provider success',
    async (status) => {
      const f = fixture();
      f.http.mockResolvedValue({ status });
      const { job } = await f.adapter.receive(incoming());
      const pending = advance(job, await runLocal(f.adapter, job));
      expect(await f.adapter.processStep({ job: pending })).toMatchObject({
        done: true,
        result: {
          localStatus: 'completed',
          providerStatus: 'rejected',
          providerHttpStatus: status,
          requiresReconciliation: true,
        },
      });
    },
  );

  test.each([408, 429, 500, 503])(
    'retries transient HTTP %s without losing callback checkpoint',
    async (status) => {
      const f = fixture();
      f.http.mockResolvedValue({ status });
      const { job } = await f.adapter.receive(incoming());
      const pending = advance(job, await runLocal(f.adapter, job));
      await expect(f.adapter.processStep({ job: pending })).rejects.toMatchObject({
        retryable: true,
      });
      expect(pending.checkpoint).toMatchObject({
        phase: 'callback',
        localRequestId: 'local-request',
      });
    },
  );

  test('sanitizes transport failures, never disclosing provider credentials in the error', async () => {
    const f = fixture();
    f.http.mockRejectedValue(new Error('synthetic-api-key synthetic-nonce'));
    const { job } = await f.adapter.receive(incoming());
    const pending = advance(job, await runLocal(f.adapter, job));
    await expect(f.adapter.processStep({ job: pending })).rejects.toThrow(
      'transcend_provider_unavailable',
    );
  });

  test('local terminal failure is unreported to provider and not marked as accepted', async () => {
    const f = fixture();
    f.service.erase.mockResolvedValue(
      local({
        state: 'failed',
        stats: {
          entities: [],
          lifecycle: { dataOutcome: 'not_started', recovery: 'retry_request' },
        },
      }),
    );
    const { job } = await f.adapter.receive(incoming());
    expect(await runLocal(f.adapter, job)).toMatchObject({
      done: true,
      result: { localStatus: 'failed', providerStatus: 'unreported', dataOutcome: 'not_started' },
    });
    expect(f.http).not.toHaveBeenCalled();
  });

  test('artifact recovery precedes callback and cannot rerun erasure', async () => {
    const f = fixture();
    const failed = local({
      state: 'failed',
      stats: { entities: [], lifecycle: { dataOutcome: 'completed', recovery: 'retry_artifact' } },
    });
    f.service.erase.mockResolvedValue(failed);
    f.service.getRequest.mockResolvedValue(failed);
    const { job } = await f.adapter.receive(incoming());
    const recovery = advance(job, await runLocal(f.adapter, job));
    expect(recovery.checkpoint).toMatchObject({ phase: 'local_recovery' });
    f.service.retryCompletion.mockResolvedValueOnce(failed);
    await expect(f.adapter.processStep({ job: recovery })).rejects.toMatchObject({
      code: 'local_execution_incomplete',
      retryable: true,
    });
    expect(await f.adapter.processStep({ job: recovery })).toMatchObject({
      done: false,
      checkpoint: { phase: 'callback' },
    });
    expect(f.service.erase).toHaveBeenCalledTimes(1);
    expect(f.http).not.toHaveBeenCalled();
  });

  test('commit ambiguity checkpoints the known local request for reconciliation', async () => {
    const f = fixture();
    f.service.erase.mockRejectedValueOnce(
      new DataSubjectPersistenceError('local-request', 'trusted-tenant', 'unknown'),
    );
    const { job } = await f.adapter.receive(incoming());
    const uncertain = await runLocal(f.adapter, job);
    expect(uncertain).toMatchObject({
      hasCommittedChanges: true,
      result: { localStatus: 'unknown', dataOutcome: 'unknown', requiresReconciliation: true },
    });
    const recovery = advance(job, uncertain);
    expect(recovery.checkpoint).toMatchObject({
      phase: 'local_recovery',
      localRequestId: 'local-request',
    });
    expect(await f.adapter.processStep({ job: recovery })).toMatchObject({
      checkpoint: { phase: 'callback' },
    });
    expect(f.service.erase).toHaveBeenCalledTimes(1);
  });

  test('a failed reservation retries the durable key instead of querying an absent candidate ID', async () => {
    const f = fixture();
    f.service.erase.mockRejectedValueOnce(
      new DataSubjectPersistenceError('absent-candidate', 'trusted-tenant', 'not_started'),
    );
    const { job } = await f.adapter.receive(incoming());
    const fenced = advance(job, await f.adapter.processStep({ job }));
    await expect(f.adapter.processStep({ job: fenced })).rejects.toMatchObject({
      code: 'local_execution_incomplete',
      retryable: true,
    });
    expect(fenced.checkpoint).toMatchObject({ phase: 'local_execution', localRequestId: null });
    expect(f.service.getRequest).not.toHaveBeenCalled();
    expect(await f.adapter.processStep({ job: fenced })).toMatchObject({
      done: false,
      checkpoint: { phase: 'callback', localRequestId: 'local-request' },
    });
    expect(f.service.erase).toHaveBeenCalledTimes(2);
    expect(f.service.erase.mock.calls[0]).toEqual(f.service.erase.mock.calls[1]);
    expect(f.service.getRequest).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  test('does not accept another tenant outcome or tampered encrypted nonce', async () => {
    const f = fixture();
    const { job } = await f.adapter.receive(incoming());
    const pending = advance(job, await runLocal(f.adapter, job));
    f.service.getRequest.mockResolvedValueOnce(local({ tenantId: 'another' }));
    await expect(f.adapter.processStep({ job: pending })).rejects.toMatchObject({
      code: 'invalid_job',
    });
    const tampered = structuredClone(pending);
    (tampered.payload as Record<string, string>).sealedNonce =
      randomBytes(50).toString('base64url');
    await expect(f.adapter.processStep({ job: tampered })).rejects.toMatchObject({
      code: 'invalid_job',
    });
    expect(f.http).not.toHaveBeenCalled();
  });

  test('rejects a manufactured subject or ciphertext before any local erasure', async () => {
    const f = fixture();
    const { job } = await f.adapter.receive(incoming());
    for (const mutation of [{ subjectId: 'another-subject' }, { sealedNonce: 'manufactured' }]) {
      const forged = structuredClone(job);
      Object.assign(forged.payload as object, mutation);
      await expect(f.adapter.processStep({ job: forged })).rejects.toMatchObject({
        code: 'invalid_job',
      });
    }
    expect(f.service.erase).not.toHaveBeenCalled();
    expect(f.service.getRequest).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  test('rejects a checkpoint referencing another completed erasure of the same subject', async () => {
    const f = fixture();
    const { job } = await f.adapter.receive(incoming());
    const pending = advance(job, await runLocal(f.adapter, job));
    (pending.checkpoint as Record<string, string>).localRequestId = 'unrelated-completed-erasure';
    f.service.getRequest.mockResolvedValue(local({ id: 'unrelated-completed-erasure' }));
    await expect(f.adapter.processStep({ job: pending })).rejects.toMatchObject({
      code: 'invalid_job',
    });
    expect(f.service.getRequest).not.toHaveBeenCalled();
    expect(f.http).not.toHaveBeenCalled();
  });

  test.each([
    'http://example.invalid',
    'https://user:secret@example.invalid',
    'https://example.invalid/callback',
    'https://example.invalid?redirect=elsewhere',
  ])('rejects unsafe configured origin %s', (sombraOrigin) => {
    const f = fixture();
    expect(
      () =>
        new TranscendErasureAdapter({ ...f.options, bindings: [{ ...f.binding, sombraOrigin }] }),
    ).toThrow('transcend_invalid_configuration');
  });

  localHttpTest(
    'a real local HTTP fixture receives the documented callback shape through a trusted transport',
    async () => {
      const received: Array<{
        url: string | undefined;
        method: string | undefined;
        nonce: string | string[] | undefined;
        body: string;
      }> = [];
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (part: Buffer) => {
          body += part.toString();
        });
        request.on('end', () => {
          received.push({
            url: request.url,
            method: request.method,
            nonce: request.headers['x-transcend-nonce'],
            body,
          });
          response.writeHead(200).end('{}');
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      try {
        const address = server.address();
        if (address === null || typeof address === 'string')
          throw new Error('fixture did not bind');
        const f = fixture();
        const adapter = new TranscendErasureAdapter({
          ...f.options,
          http: async (request) => {
            // Only this test transport replaces the configured HTTPS origin with its owned fixture.
            const response = await fetch(`http://127.0.0.1:${address.port}/v1/data-silo`, request);
            await response.body?.cancel();
            return { status: response.status };
          },
        });
        const { job } = await adapter.receive(incoming());
        const pending = advance(job, await runLocal(adapter, job));
        expect(await adapter.processStep({ job: pending })).toMatchObject({
          result: { providerStatus: 'accepted' },
        });
        expect(received).toEqual([
          { url: '/v1/data-silo', method: 'PUT', nonce: 'synthetic-nonce', body: '{}' },
        ]);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
