// In an application, replace this repository-local import with @nestarc/data-subject.
import { fromPrisma, type PrismaDelegate, type RegisterInput } from '../../src';

const policy = {
  entityName: 'User',
  subjectField: 'userId',
  fields: {
    email: 'delete',
    displayName: 'delete',
    passwordHash: 'delete',
    sessionToken: 'delete',
  },
  // A separate allowlist controls disclosure; erase policies never grant export access.
  exportFields: ['email', 'displayName'],
} satisfies RegisterInput['policy'];

export function tenantUserEntity(delegate: PrismaDelegate): RegisterInput {
  return {
    policy,
    executor: fromPrisma({ delegate, subjectField: 'userId', tenantField: 'tenantId' }),
  };
}

/** Pass this same fixed ID to DataSubjectModule.forRoot({ singleTenantId, ... }). */
export function singleTenantUserEntity(
  delegate: PrismaDelegate,
  singleTenantId: string,
): RegisterInput {
  return {
    policy,
    executor: fromPrisma({ delegate, subjectField: 'userId', singleTenantId }),
  };
}
