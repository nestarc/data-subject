import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  DenyAllHostAccessService,
  HostAccessService,
  PrivacyController,
  PrivacyHttpRequest,
  PrivacyIdentityGuard,
} from '../../examples/tenant-safe/privacy.module';
import { DataSubjectService, InMemoryArtifactStorage, InMemoryRequestStorage, Registry } from '../../src';

function fixture() {
  const requests = new InMemoryRequestStorage();
  const artifacts = new InMemoryArtifactStorage();
  const service = new DataSubjectService({
    registry: new Registry(), requestStorage: requests, artifactStorage: artifacts, slaDays: 30,
  });
  const access = {
    authenticateBearer: jest.fn(async () => ({ actorId: 'actor-a', tenantId: 'tenant-a' })),
    isAllowed: jest.fn(async () => true),
    verifyOwnSubject: jest.fn(async () => ({ subjectId: 'subject-a', validUntil: new Date(Date.now() + 60_000) })),
  };
  const guard = new PrivacyIdentityGuard(access, new Reflector());
  const controller = new PrivacyController(service);
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
});
