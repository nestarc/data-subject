import 'reflect-metadata';
import { BadRequestException, ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import {
  DenyAllHostAccessService,
  HostAccessService,
  PrivacyController,
  PrivacyHttpRequest,
  PrivacyIdentityGuard,
  TenantSafePrivacyModule,
} from '../../examples/tenant-safe/privacy.module';
import { DataSubjectError, DataSubjectErrorCode, DataSubjectPersistenceError, DataSubjectService, exportArtifactKey, InMemoryArtifactStorage, InMemoryRequestStorage, Registry, sha256Hex } from '../../src';

function fixture(options: { durable?: boolean; requireErasePreview?: boolean; transaction?: boolean } = {}) {
  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const service = new DataSubjectService({
    registry: new Registry(), requestStorage: requests, artifactStorage: artifacts, slaDays: 30,
    // This fixture has no business entities; real hosts must bind a DB transaction.
    ...(options.transaction ? { runInTransaction: async <T>(work: () => Promise<T>) => work() } : {}),
  });
  const access = {
    authenticateBearer: jest.fn(async () => ({ actorId: 'actor-a', tenantId: 'tenant-a' })),
    isAllowed: jest.fn(async () => true),
    verifyOwnSubject: jest.fn(async () => ({ subjectId: 'subject-a', validUntil: new Date(Date.now() + 60_000) })),
  };
  const guard = new PrivacyIdentityGuard(access, new Reflector());
  const controller = new PrivacyController(service, access, {
    durable: options.durable ?? false, requireErasePreview: options.requireErasePreview ?? false,
  });
  const request: PrivacyHttpRequest = { headers: { authorization: 'Bearer valid-session' } };
  return { requests, artifacts, service, access, guard, controller, request };
}

function context(
  request: PrivacyHttpRequest,
  handler: (...args: never[]) => unknown = PrivacyController.prototype.exportOwnData,
): ExecutionContext {
  return {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('tenant-safe NestJS host example', () => {
  it('fails closed before a host identity service is configured', async () => {
    const guard = new PrivacyIdentityGuard(new DenyAllHostAccessService(), new Reflector());
    await expect(guard.canActivate(context({ headers: { authorization: 'Bearer anything' } })))
      .rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([undefined, '', 'Basic anything', ['Bearer one', 'Bearer two']])('rejects invalid authorization headers', async (authorization) => {
    const f = fixture();
    f.request.headers.authorization = authorization;
    await expect(f.guard.canActivate(context(f.request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(f.access.authenticateBearer).not.toHaveBeenCalled();
  });

  it('checks operation permission before subject verification and execution', async () => {
    const f = fixture();
    f.access.isAllowed.mockResolvedValue(false);
    const execute = jest.spyOn(f.service, 'erase');
    await expect(f.guard.canActivate(context(f.request, PrivacyController.prototype.eraseOwnData)))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.access.isAllowed).toHaveBeenCalledWith({ actorId: 'actor-a', tenantId: 'tenant-a' }, 'erase');
    expect(f.access.verifyOwnSubject).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([null, { subjectId: '', validUntil: new Date('2099-01-01') },
    { subjectId: 'subject-a', validUntil: new Date('2000-01-01') },
    { subjectId: 'subject-a', validUntil: new Date('invalid') }])('rejects missing, expired, or invalid subject proof', async (proof) => {
    const f = fixture();
    const access: HostAccessService = { ...f.access, verifyOwnSubject: async () => proof };
    const guard = new PrivacyIdentityGuard(access, new Reflector());
    await expect(guard.canActivate(context(f.request))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('uses the authenticated tenant and verified subject despite forged body IDs', async () => {
    const f = fixture();
    f.request.body = { tenantId: 'tenant-b', subjectId: 'subject-b', requestedBy: 'admin' };
    const execute = jest.spyOn(f.service, 'export');
    await f.guard.canActivate(context(f.request));
    const response = await f.controller.exportOwnData(f.request);
    expect(execute).toHaveBeenCalledWith('subject-a', 'tenant-a', { requestedBy: 'actor-a' });
    const persisted = await f.service.getRequest(response.id, 'tenant-a');
    expect(persisted.requestedBy).toBe('actor-a');
    expect(response).not.toHaveProperty('artifactUrl');
    expect(response).not.toHaveProperty('subjectId');
    expect(response.artifactReady).toBe(true);
  });

  it('rejects controller calls with no context established by the guard', async () => {
    const f = fixture();
    f.request.body = { subjectId: 'subject-a', tenantId: 'tenant-a' };
    await expect(f.controller.exportOwnData(f.request)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(await f.requests.listByTenant('tenant-a', {})).toEqual([]);
  });

  it.each([
    ['subject-b', 'tenant-a'],
    ['subject-a', 'tenant-b'],
  ])('hides requests and artifacts for another owner (%s, %s)', async (subjectId, tenantId) => {
    const f = fixture();
    const other = await f.service.export(subjectId, tenantId);
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.getOwnRequest));
    const getArtifact = jest.spyOn(f.service, 'getArtifact');
    await expect(f.controller.getOwnRequest(other.id, f.request)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.controller.downloadOwnArtifact(other.id, f.request)).rejects.toBeInstanceOf(NotFoundException);
    expect(getArtifact).not.toHaveBeenCalled();
  });

  it('streams an authorized artifact through scoped access', async () => {
    const f = fixture();
    const own = await f.service.export('subject-a', 'tenant-a');
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.downloadOwnArtifact));
    const getArtifact = jest.spyOn(f.service, 'getArtifact');
    const file = await f.controller.downloadOwnArtifact(own.id, f.request);
    expect(getArtifact).toHaveBeenCalledWith(own.id, 'tenant-a');
    expect(file.getHeaders()).toMatchObject({ type: 'application/zip' });
  });

  it('does not reuse a previously verified context after authentication fails', async () => {
    const f = fixture();
    await f.guard.canActivate(context(f.request));
    delete f.request.headers.authorization;
    await expect(f.guard.canActivate(context(f.request))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(f.controller.exportOwnData(f.request)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('connects the execution configuration through the Nest module', async () => {
    const f = fixture();
    const module = await Test.createTestingModule({ imports: [TenantSafePrivacyModule.forRoot({
      requestStorage: f.requests, artifactStorage: f.artifacts,
      runInTransaction: async work => work(), requireErasePreview: true,
    }, f.access)] }).compile();
    try {
      const guard = module.get(PrivacyIdentityGuard);
      const controller = module.get(PrivacyController);
      await guard.canActivate(context(f.request, PrivacyController.prototype.eraseOwnData));
      await expect(controller.eraseOwnData(f.request)).rejects.toBeInstanceOf(BadRequestException);
      const preview = await controller.previewOwnErasure(f.request);
      f.request.body = { preview };
      await expect(controller.eraseOwnData(f.request)).resolves.toMatchObject({
        state: 'completed', evidenceVersion: 'data-subject.evidence.v2', verification: [],
      });
    } finally { await module.close(); }
  });

  it('rejects required previews without transaction wiring at module setup', () => {
    const f = fixture();
    expect(() => TenantSafePrivacyModule.forRoot({
      requestStorage: f.requests, artifactStorage: f.artifacts, requireErasePreview: true,
    })).toThrow('transaction-bound');
  });

  it('previews only the authenticated scope without creating a request', async () => {
    const f = fixture();
    f.request.body = { tenantId: 'tenant-b', subjectId: 'subject-b' };
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.previewOwnErasure));
    const preview = await f.controller.previewOwnErasure(f.request);
    expect(preview).toMatchObject({ subjectId: 'subject-a', tenantId: 'tenant-a' });
    expect(preview.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.requests.listByTenant('tenant-a')).toEqual([]);
    expect(f.access.isAllowed).toHaveBeenCalledWith(expect.anything(), 'erase');
  });

  it('returns a sanitized 409 when a signed preview is tampered with', async () => {
    const f = fixture({ transaction: true, requireErasePreview: true });
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.eraseOwnData));
    const preview = await f.controller.previewOwnErasure(f.request);
    f.request.body = { preview: { ...preview, tenantId: 'tenant-b' } };
    await expect(f.controller.eraseOwnData(f.request)).rejects.toMatchObject({
      status: 409, response: { code: DataSubjectErrorCode.PlanMismatch },
    });
    expect(await f.requests.listByTenant('tenant-a')).toEqual([]);
  });

  it.each([null, [], false, { preview: null }, { preview: false }, { preview: [] }])('rejects malformed erasure body %#', async body => {
    const f = fixture({ transaction: true });
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.eraseOwnData));
    f.request.body = body;
    await expect(f.controller.eraseOwnData(f.request)).rejects.toBeInstanceOf(BadRequestException);
    expect(await f.requests.listByTenant('tenant-a')).toEqual([]);
  });

  it.each(['exportOwnData', 'eraseOwnData'] as const)('forwards a stable actor/subject-scoped durable key from %s', async method => {
    const f = fixture({ durable: true });
    const response = await f.service.export('subject-a', 'tenant-a');
    const execute = jest.spyOn(f.service, method === 'exportOwnData' ? 'export' : 'erase').mockResolvedValue(response);
    f.request.headers['idempotency-key'] = 'operation-123';
    f.request.body = { tenantId: 'forged', subjectId: 'forged', requestedBy: 'forged', requestKey: 'forged' };
    await f.guard.canActivate(context(f.request, PrivacyController.prototype[method]));
    await f.controller[method](f.request);
    await f.controller[method](f.request);
    expect(execute).toHaveBeenNthCalledWith(1, 'subject-a', 'tenant-a', {
      requestedBy: 'actor-a', requestKey: sha256Hex(JSON.stringify(['actor-a', 'subject-a', 'operation-123'])),
    });
    expect(execute.mock.calls[1]).toEqual(execute.mock.calls[0]);
    f.access.authenticateBearer.mockResolvedValue({ actorId: 'actor-b', tenantId: 'tenant-a' });
    await f.guard.canActivate(context(f.request, PrivacyController.prototype[method]));
    await f.controller[method](f.request);
    expect(execute.mock.calls[2][2]?.requestKey).not.toBe(execute.mock.calls[0][2]?.requestKey);
  });

  it.each([undefined, '', ' ', ['one', 'two'], 'x'.repeat(201)])('rejects invalid or missing durable key %# before execution', async key => {
    const f = fixture({ durable: true });
    f.request.headers['idempotency-key'] = key;
    const execute = jest.spyOn(f.service, 'export');
    await f.guard.canActivate(context(f.request));
    await expect(f.controller.exportOwnData(f.request)).rejects.toBeInstanceOf(BadRequestException);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects idempotency claims when durable execution is not configured', async () => {
    const f = fixture();
    f.request.headers['idempotency-key'] = 'operation';
    await f.guard.canActivate(context(f.request));
    await expect(f.controller.exportOwnData(f.request)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves the reconciliation ID and hides internal error details', async () => {
    const f = fixture();
    await f.guard.canActivate(context(f.request));
    jest.spyOn(f.service, 'export').mockRejectedValue(new DataSubjectPersistenceError('request-unknown', 'tenant-a', 'unknown'));
    await expect(f.controller.exportOwnData(f.request)).rejects.toMatchObject({ status: 500, response: {
      code: DataSubjectErrorCode.RequestPersistenceFailed, requestId: 'request-unknown',
      dataOutcome: 'unknown', recovery: 'reconcile_request',
    } });
    jest.spyOn(f.service, 'export').mockRejectedValue(new DataSubjectError(DataSubjectErrorCode.RequestConflict, 'internal secret'));
    await expect(f.controller.exportOwnData(f.request)).rejects.toMatchObject({
      status: 409, response: { code: DataSubjectErrorCode.RequestConflict },
    });
  });

  it('retries completion only after owner and retry permission checks', async () => {
    const f = fixture();
    const own = await f.service.export('subject-a', 'tenant-a');
    const other = await f.service.export('subject-b', 'tenant-a');
    const retry = jest.spyOn(f.service, 'retryCompletion').mockResolvedValue(own);
    const erase = jest.spyOn(f.service, 'erase');
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.retryOwnCompletion));
    expect(f.access.isAllowed).toHaveBeenCalledWith(expect.anything(), 'retry');
    await expect(f.controller.retryOwnCompletion(other.id, f.request)).rejects.toBeInstanceOf(NotFoundException);
    expect(retry).not.toHaveBeenCalled();
    await f.controller.retryOwnCompletion(own.id, f.request);
    expect(retry).toHaveBeenCalledWith(own.id, 'tenant-a');
    expect(erase).not.toHaveBeenCalled();
  });

  it('requires the artifact-specific permission in addition to read access', async () => {
    const f = fixture();
    const own = await f.service.erase('subject-a', 'tenant-a');
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.downloadOwnArtifact));
    f.access.isAllowed.mockResolvedValue(false);
    const read = jest.spyOn(f.service, 'getArtifact');
    await expect(f.controller.downloadOwnArtifact(own.id, f.request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.access.isAllowed).toHaveBeenLastCalledWith(expect.anything(), 'evidence:download');
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['hash', 'content-type', 'failed-state'] as const)('does not stream artifacts with invalid %s', async invalid => {
    const f = fixture();
    const own = await f.service.export('subject-a', 'tenant-a');
    const key = exportArtifactKey('tenant-a', own.id);
    const saved = (await f.artifacts.get(key))!;
    if (invalid === 'hash') await f.artifacts.put(key, Buffer.from('corrupted'), saved.contentType);
    if (invalid === 'content-type') await f.artifacts.put(key, saved.body, 'text/html');
    if (invalid === 'failed-state') await f.requests.update(own.id, 'tenant-a', { state: 'failed' });
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.downloadOwnArtifact));
    await expect(f.controller.downloadOwnArtifact(own.id, f.request)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('does not report or serve an artifact while its upload requires recovery', async () => {
    const f = fixture();
    const own = await f.service.export('subject-a', 'tenant-a');
    await f.requests.update(own.id, 'tenant-a', { stats: {
      entities: [], lifecycle: {
        dataOutcome: 'completed',
        artifactFailure: { code: DataSubjectErrorCode.ArtifactWriteFailed, recovery: 'retry_artifact' },
      },
    } });
    await f.guard.canActivate(context(f.request, PrivacyController.prototype.getOwnRequest));
    await expect(f.controller.getOwnRequest(own.id, f.request)).resolves.toMatchObject({ artifactReady: false });
    const read = jest.spyOn(f.service, 'getArtifact');
    await expect(f.controller.downloadOwnArtifact(own.id, f.request)).rejects.toBeInstanceOf(NotFoundException);
    expect(read).not.toHaveBeenCalled();
  });
});
