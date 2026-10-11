// In an application, replace this repository-local import with @nestarc/data-subject.
import {
  definePolicy,
  fromPrisma,
  type DataSubjectModuleOptions,
  type EntityDefinition,
  type PrismaDelegate,
} from '../../src';

const userPolicy = {
  entityName: 'User',
  subjectField: 'userId',
  stableIdField: 'id',
  rowLevel: 'delete-fields',
  fields: {
    email: 'delete',
    displayName: 'delete',
    passwordHash: 'delete',
    sessionToken: 'delete',
  },
  // A separate allowlist controls disclosure; erase policies never grant export access.
  exportFields: ['email', 'displayName'],
  ignoredFields: {
    id: 'Immutable row identity retained for post-write verification',
    userId: 'Subject lookup key retained while personal fields are cleared',
  },
} satisfies Omit<EntityDefinition, 'scope'>;

/** Pass these same definitions to lintPrismaSchema in CI. */
export const tenantUserDefinitions = definePolicy([
  {
    ...userPolicy,
    scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
    ignoredFields: {
      ...userPolicy.ignoredFields,
      tenantId: 'Tenant boundary retained on every read and write',
    },
  },
]);

/** This schema variant has no tenantId column. */
export function singleTenantUserDefinitions(singleTenantId: string): EntityDefinition[] {
  return definePolicy([
    { ...userPolicy, scope: { mode: 'single-tenant', tenantId: singleTenantId } },
  ]);
}

type DefinitionRegistration = NonNullable<DataSubjectModuleOptions['definitions']>[number];

export function tenantUserEntity(delegate: PrismaDelegate): DefinitionRegistration {
  return registration(tenantUserDefinitions[0], delegate);
}

/** Pass this same fixed ID to DataSubjectModule.forRoot({ singleTenantId, ... }). */
export function singleTenantUserEntity(
  delegate: PrismaDelegate,
  singleTenantId: string,
): DefinitionRegistration {
  return registration(singleTenantUserDefinitions(singleTenantId)[0], delegate);
}

function registration(
  definition: EntityDefinition,
  delegate: PrismaDelegate,
): DefinitionRegistration {
  return {
    definition,
    executor: fromPrisma({
      delegate,
      subjectField: definition.subjectField,
      stableIdField: definition.stableIdField,
      ...(definition.scope.mode === 'multi-tenant'
        ? { tenantField: definition.scope.tenantField }
        : { singleTenantId: definition.scope.tenantId }),
    }),
  };
}
