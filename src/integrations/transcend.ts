import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto';

import type { DataSubjectService } from '../data-subject.service';
import { DataSubjectPersistenceError } from '../errors';
import type {
  DurableJobStore,
  JobJson,
  JobRecord,
  JobStepResult,
  JobTransaction,
} from '../jobs/types';
import { stableStringify } from '../stable-json';
import type { DataSubjectRequest } from '../types';
import {
  jsonObject,
  object,
  signingKeys,
  text,
  TranscendIntegrationError,
  verifySombraToken,
} from './transcend-auth';

export { TranscendIntegrationError } from './transcend-auth';

export const TRANSCEND_ERASURE_JOB = 'transcend-erasure';

export interface TranscendBinding {
  /** Stable operator-selected identity; never choose a tenant from the webhook body. */
  id: string;
  organizationId: string;
  dataSiloId: string;
  tenantId: string;
  audience: string;
  publicKeys: readonly string[];
  /** Set this as a custom x-data-subject-webhook-secret header in Transcend. */
  webhookSecret: string;
  /** Operator-configured HTTPS origin, without path/query/userinfo. */
  sombraOrigin: string;
  apiKey: string;
  sombraApiKey?: string;
  identifierType: string;
  dataSubjectType: string;
  /** Test webhooks are rejected unless explicitly routed to this test binding. */
  allowTestRequests?: boolean;
  resolveSubject(identifier: string): Promise<string | null>;
}

export interface TranscendHttpRequest {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  body: string;
  redirect: 'error';
  signal: AbortSignal;
}

export interface TranscendAdapterOptions {
  bindings: readonly TranscendBinding[];
  jobs: Pick<DurableJobStore, 'submit' | 'get'>;
  service: Pick<DataSubjectService, 'erase' | 'getRequest' | 'retryCompletion'>;
  /** Keep this stable across workers/restarts. Rotate only after draining old jobs. */
  nonceEncryptionKey: Buffer;
  clock?: () => Date;
  callbackTimeoutMs?: number;
  /** A trusted transport override for tests/proxies; it must honor redirect and abort. */
  http?: (request: TranscendHttpRequest) => Promise<{ status: number }>;
}

interface Binding extends Omit<TranscendBinding, 'publicKeys'> {
  keys: KeyObject[];
}
interface Payload {
  bindingId: string;
  fingerprint: string;
  localKey: string;
  subjectId: string;
  sealedNonce: string;
}

/** Experimental server-webhook adapter, independently scoped to one local erasure system. */
export class TranscendErasureAdapter {
  private readonly bindings: Binding[];
  private readonly encryptionKey: Buffer;
  private readonly clock: () => Date;
  private readonly timeout: number;
  private readonly http: NonNullable<TranscendAdapterOptions['http']>;

  constructor(private readonly options: TranscendAdapterOptions) {
    try {
      if (!Buffer.isBuffer(options.nonceEncryptionKey) || options.nonceEncryptionKey.length !== 32)
        throw new Error();
      this.encryptionKey = Buffer.from(options.nonceEncryptionKey);
      this.clock = options.clock ?? (() => new Date());
      this.timeout = options.callbackTimeoutMs ?? 10_000;
      if (!Number.isSafeInteger(this.timeout) || this.timeout < 1 || this.timeout > 30_000)
        throw new Error();
      const ids = new Set<string>();
      const routes = new Set<string>();
      if (!options.bindings.length) throw new Error();
      this.bindings = options.bindings.map((binding) => {
        for (const field of [
          'id',
          'organizationId',
          'dataSiloId',
          'tenantId',
          'audience',
          'identifierType',
          'dataSubjectType',
          'apiKey',
        ] as const)
          text(binding[field]);
        text(binding.webhookSecret, 4_096);
        if (Buffer.byteLength(binding.webhookSecret) < 32) throw new Error();
        if (binding.sombraApiKey !== undefined) text(binding.sombraApiKey);
        const url = new URL(binding.sombraOrigin);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== '/'
        )
          throw new Error();
        const route = stableStringify([binding.organizationId, binding.dataSiloId]);
        if (ids.has(binding.id) || routes.has(route)) throw new Error();
        ids.add(binding.id);
        routes.add(route);
        return { ...binding, sombraOrigin: url.origin, keys: signingKeys(binding.publicKeys) };
      });
      this.http =
        options.http ??
        (async (request) => {
          const response = await fetch(request.url, request);
          await response.body?.cancel();
          return { status: response.status };
        });
    } catch {
      throw new TranscendIntegrationError('invalid_configuration');
    }
  }

  /** Return HTTP 200 only after this resolves: receipt is not erasure completion. */
  async receive(input: {
    body: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): Promise<{ job: JobRecord; created: boolean }> {
    let body: Record<string, unknown>;
    try {
      if (!Buffer.isBuffer(input.body) || input.body.length > 65_536) throw new Error();
      body = jsonObject(input.body.toString('utf8'));
    } catch {
      throw new TranscendIntegrationError('invalid_webhook');
    }
    const extras = object(body.extras);
    const organizationId = text(object(extras.organization).id);
    const dataSiloId = text(object(extras.dataSilo).id);
    const binding = this.bindings.find(
      (entry) => entry.organizationId === organizationId && entry.dataSiloId === dataSiloId,
    );
    if (!binding) throw new TranscendIntegrationError('unauthorized_webhook');
    const secret = header(input.headers, 'x-data-subject-webhook-secret');
    if (!safeEqual(secret, binding.webhookSecret))
      throw new TranscendIntegrationError('unauthorized_webhook');
    verifySombraToken(
      header(input.headers, 'x-sombra-token'),
      binding.keys,
      binding.audience,
      this.clock(),
    );
    if (body.type !== 'ERASURE') throw new TranscendIntegrationError('unsupported_request');
    if (typeof body.isTest !== 'boolean' || (body.isTest && !binding.allowTestRequests))
      throw new TranscendIntegrationError('unsupported_request');
    if (text(object(body.dataSubject).type) !== binding.dataSubjectType)
      throw new TranscendIntegrationError('unsupported_request');
    const profile = object(extras.profile);
    const identifier = text(profile.identifier);
    if (text(profile.type) !== binding.identifierType)
      throw new TranscendIntegrationError('unsupported_request');
    const requestId = text(object(extras.request).id);
    const profileId = text(profile.id);
    const requestDataSiloId = text(profile.RequestDataSiloId);
    const nonce = text(header(input.headers, 'x-transcend-nonce'), 8_192);
    const identity = stableStringify([
      binding.id,
      organizationId,
      dataSiloId,
      requestId,
      profileId,
      requestDataSiloId,
    ]);
    const id = `transcend_${digest(identity)}`;
    const fingerprint = digest(
      stableStringify({
        identity,
        identifier,
        type: body.type,
        isTest: body.isTest,
        subjectType: binding.dataSubjectType,
        identifierType: binding.identifierType,
      }),
    );
    // A subject mapping may no longer exist after erasure. Recognized replays use the original job.
    const existing = await this.options.jobs.get(id, binding.tenantId);
    if (existing) return this.replay(existing, binding, fingerprint);
    const subjectId = await binding.resolveSubject(identifier);
    if (subjectId === null) throw new TranscendIntegrationError('subject_not_mapped');
    text(subjectId);
    const payload: Payload = {
      bindingId: binding.id,
      fingerprint,
      localKey: id,
      subjectId,
      sealedNonce: '',
    };
    payload.sealedNonce = this.seal(nonce, this.payloadAad(binding.tenantId, id, payload));
    try {
      return await this.options.jobs.submit({
        id,
        tenantId: binding.tenantId,
        kind: TRANSCEND_ERASURE_JOB,
        idempotencyKey: id,
        payload: { ...payload },
      });
    } catch (error) {
      // Concurrent receipts encrypt with different IVs. Only accept the same immutable request.
      const winner = await this.options.jobs.get(id, binding.tenantId);
      if (winner) return this.replay(winner, binding, fingerprint);
      throw error;
    }
  }

  /** Use with jobs.runNext(adapter.processStep.bind(adapter), { kind: TRANSCEND_ERASURE_JOB }). */
  async processStep({ job }: Pick<JobTransaction, 'job'>): Promise<JobStepResult> {
    const payload = this.payload(job);
    const binding = this.bindings.find(
      (entry) => entry.id === payload.bindingId && entry.tenantId === job.tenantId,
    );
    if (!binding) throw new TranscendIntegrationError('invalid_job');
    const aad = this.payloadAad(job.tenantId, job.id, payload);
    // Authenticate every execution-affecting payload field before any local database call.
    const nonce = this.open(payload.sealedNonce, aad);
    if (job.checkpoint === null) {
      // Commit this fence before calling a service that commits independently of the queue.
      // After this point cancellation must conservatively require local-key reconciliation.
      return {
        done: false,
        processedRows: 0,
        hasCommittedChanges: true,
        checkpoint: this.checkpoint('local_execution', null, job, payload),
        result: {
          localStatus: 'unknown',
          dataOutcome: 'unknown',
          providerStatus: 'unreported',
          requiresReconciliation: true,
        },
      };
    }
    const checkpoint = object(job.checkpoint);
    const phase = text(checkpoint.phase);
    const localRequestId =
      checkpoint.localRequestId === null ? null : text(checkpoint.localRequestId);
    const proof = text(checkpoint.proof);
    const expectedProof = this.checkpoint(phase, localRequestId, job, payload).proof;
    if (!safeEqual(proof, expectedProof)) throw new TranscendIntegrationError('invalid_job');
    if (phase === 'local_execution') {
      if (localRequestId !== null) throw new TranscendIntegrationError('invalid_job');
      try {
        const request = await this.options.service.erase(payload.subjectId, job.tenantId, {
          requestKey: payload.localKey,
          requestedBy: `transcend:${binding.id}`,
        });
        return this.localResult(request, job, payload);
      } catch (error) {
        if (!(error instanceof DataSubjectPersistenceError) || error.tenantId !== job.tenantId)
          throw error;
        // Reservation may not have committed, and its candidate ID may not exist.
        // Preserve the existing execution fence and retry the original durable key.
        if (error.dataOutcome === 'not_started')
          throw new TranscendIntegrationError('local_execution_incomplete', true);
        return {
          done: false,
          processedRows: 0,
          hasCommittedChanges: true,
          checkpoint: this.checkpoint('local_recovery', error.requestId, job, payload),
          result: {
            localRequestId: error.requestId,
            localStatus: 'unknown',
            dataOutcome: error.dataOutcome,
            providerStatus: 'unreported',
            requiresReconciliation: true,
          },
        };
      }
    }
    if (localRequestId === null) throw new TranscendIntegrationError('invalid_job');
    if (checkpoint.phase === 'local_recovery') {
      let request = await this.options.service.getRequest(localRequestId, job.tenantId);
      this.assertLocal(request, job, payload);
      if (request.stats?.lifecycle?.dataOutcome === 'completed' && request.state !== 'completed') {
        request = await this.options.service.retryCompletion(localRequestId, job.tenantId);
        if (
          request.state !== 'completed' &&
          request.stats?.lifecycle?.recovery === 'retry_artifact'
        )
          throw new TranscendIntegrationError('local_execution_incomplete', true);
      }
      // A reserved, unexecuted request can safely use the original durable request key again.
      if (request.state === 'created')
        request = await this.options.service.erase(payload.subjectId, job.tenantId, {
          requestKey: payload.localKey,
          requestedBy: `transcend:${binding.id}`,
        });
      return this.localResult(request, job, payload);
    }
    if (checkpoint.phase !== 'callback') throw new TranscendIntegrationError('invalid_job');
    // Re-read the durable local outcome; never trust a manufactured queue checkpoint.
    const request = await this.options.service.getRequest(localRequestId, job.tenantId);
    this.assertLocal(request, job, payload);
    if (request.state !== 'completed' || request.stats?.lifecycle?.dataOutcome !== 'completed')
      throw new TranscendIntegrationError('invalid_job');
    const headers: Record<string, string> = {
      authorization: `Bearer ${binding.apiKey}`,
      'x-transcend-nonce': nonce,
      'content-type': 'application/json',
    };
    if (binding.sombraApiKey) headers['x-sombra-authorization'] = `Bearer ${binding.sombraApiKey}`;
    let status: number;
    try {
      ({ status } = await this.http({
        url: `${binding.sombraOrigin}/v1/data-silo`,
        method: 'PUT',
        headers,
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeout),
      }));
    } catch {
      throw new TranscendIntegrationError('provider_unavailable', true);
    }
    if (
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599 ||
      status === 408 ||
      status === 429 ||
      status >= 500
    )
      throw new TranscendIntegrationError('provider_unavailable', true);
    const result: JobJson = {
      localRequestId,
      localStatus: 'completed',
      dataOutcome: 'completed',
      providerStatus: status === 200 ? 'accepted' : 'rejected',
      providerHttpStatus: status,
      requiresReconciliation: status !== 200,
    };
    return {
      done: true,
      processedRows: 0,
      checkpoint: this.checkpoint('finished', localRequestId, job, payload),
      result,
    };
  }

  private localResult(
    request: DataSubjectRequest,
    job: JobRecord,
    payload: Payload,
  ): JobStepResult {
    this.assertLocal(request, job, payload);
    const dataOutcome = request.stats?.lifecycle?.dataOutcome ?? 'unknown';
    if (request.state === 'completed' && dataOutcome === 'completed') {
      return {
        done: false,
        processedRows: 0,
        hasCommittedChanges: true,
        checkpoint: this.checkpoint('callback', request.id, job, payload),
        result: {
          localRequestId: request.id,
          localStatus: 'completed',
          dataOutcome,
          providerStatus: 'pending',
        },
      };
    }
    if (dataOutcome === 'completed' && request.stats?.lifecycle?.recovery === 'retry_artifact')
      return {
        done: false,
        processedRows: 0,
        hasCommittedChanges: true,
        checkpoint: this.checkpoint('local_recovery', request.id, job, payload),
      };
    return {
      done: true,
      processedRows: 0,
      hasCommittedChanges: dataOutcome === 'completed',
      checkpoint: this.checkpoint('finished', request.id, job, payload),
      result: {
        localRequestId: request.id,
        localStatus: 'failed',
        dataOutcome,
        providerStatus: 'unreported',
        requiresReconciliation: true,
      },
    };
  }

  private assertLocal(request: DataSubjectRequest, job: JobRecord, payload: Payload): void {
    if (
      request.tenantId !== job.tenantId ||
      request.subjectId !== payload.subjectId ||
      request.type !== 'erase'
    )
      throw new TranscendIntegrationError('invalid_job');
  }

  private payload(job: JobRecord): Payload {
    try {
      if (job.kind !== TRANSCEND_ERASURE_JOB || job.id !== job.idempotencyKey) throw new Error();
      const payload = object(job.payload);
      for (const key of ['bindingId', 'fingerprint', 'localKey', 'subjectId', 'sealedNonce'])
        text(payload[key], 16_384);
      if (payload.localKey !== job.id || !/^[a-f0-9]{64}$/.test(String(payload.fingerprint)))
        throw new Error();
      return payload as unknown as Payload;
    } catch {
      throw new TranscendIntegrationError('invalid_job');
    }
  }

  private replay(
    job: JobRecord,
    binding: Binding,
    fingerprint: string,
  ): { job: JobRecord; created: false } {
    const payload = this.payload(job);
    if (
      job.tenantId !== binding.tenantId ||
      payload.bindingId !== binding.id ||
      payload.fingerprint !== fingerprint
    )
      throw new TranscendIntegrationError('invalid_webhook');
    this.open(payload.sealedNonce, this.payloadAad(job.tenantId, job.id, payload));
    return { job, created: false };
  }

  private payloadAad(tenantId: string, jobId: string, payload: Payload): string {
    return stableStringify({
      domain: 'data-subject.transcend.v1',
      tenantId,
      jobId,
      bindingId: payload.bindingId,
      localKey: payload.localKey,
      fingerprint: payload.fingerprint,
      subjectId: payload.subjectId,
    });
  }

  private checkpoint(
    phase: string,
    localRequestId: string | null,
    job: JobRecord,
    payload: Payload,
  ): { phase: string; localRequestId: string | null; proof: string } {
    const key = createHmac('sha256', this.encryptionKey)
      .update('data-subject.transcend.checkpoint-key.v1')
      .digest();
    const proof = createHmac('sha256', key)
      .update(
        stableStringify({
          phase,
          localRequestId,
          payload: this.payloadAad(job.tenantId, job.id, payload),
        }),
      )
      .digest('hex');
    return { phase, localRequestId, proof };
  }

  private seal(nonce: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(nonce, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  private open(sealed: string, aad: string): string {
    try {
      const value = Buffer.from(sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, value.subarray(0, 12));
      decipher.setAAD(Buffer.from(aad));
      decipher.setAuthTag(value.subarray(12, 28));
      return text(
        Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'),
        8_192,
      );
    } catch {
      throw new TranscendIntegrationError('invalid_job');
    }
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function header(headers: Record<string, string | string[] | undefined>, name: string): string {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length !== 1 || typeof matches[0][1] !== 'string')
    throw new TranscendIntegrationError('unauthorized_webhook');
  return text(matches[0][1], 16_384);
}
