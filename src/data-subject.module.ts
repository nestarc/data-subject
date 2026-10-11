import { DynamicModule, Module, type Provider } from '@nestjs/common';

import { DataSubjectService, type DataSubjectServiceDeps } from './data-subject.service';
import { Registry, type RegisterInput } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStorage } from './storage/request-storage.interface';
import type { EntityDefinition } from './policy-definition';
import type { EntityExecutor } from './types';

export const DATA_SUBJECT_REGISTRY = Symbol('DATA_SUBJECT_REGISTRY');

export interface DataSubjectModuleOptions {
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays?: number;
  singleTenantId?: string;
  strictLegalBasis?: boolean;
  entities?: RegisterInput[];
  definitions?: Array<{ definition: EntityDefinition; executor: EntityExecutor }>;
  durableStore?: DataSubjectServiceDeps['durableStore'];
  artifactRetryTtlMs?: DataSubjectServiceDeps['artifactRetryTtlMs'];
  previewSigningKey?: DataSubjectServiceDeps['previewSigningKey'];
  previewTtlMs?: number;
  allowUnverified?: boolean;
  publishOutbox?: DataSubjectServiceDeps['publishOutbox'];
  publishAudit?: DataSubjectServiceDeps['publishAudit'];
  runInTransaction?: DataSubjectServiceDeps['runInTransaction'];
}

@Module({})
export class DataSubjectModule {
  static forRoot(options: DataSubjectModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: DATA_SUBJECT_REGISTRY,
        useFactory: () => {
          const registry = new Registry({
            strictLegalBasis: options.strictLegalBasis,
          });

          for (const entity of options.entities ?? []) {
            registry.register(entity);
          }
          for (const entity of options.definitions ?? []) {
            registry.registerDefinition(entity.definition, entity.executor);
          }

          return registry;
        },
      },
      {
        provide: DataSubjectService,
        useFactory: (registry: Registry) =>
          new DataSubjectService({
            registry,
            requestStorage: options.requestStorage,
            artifactStorage: options.artifactStorage,
            slaDays: options.slaDays ?? 30,
            singleTenantId: options.singleTenantId,
            durableStore: options.durableStore,
            artifactRetryTtlMs: options.artifactRetryTtlMs,
            previewSigningKey: options.previewSigningKey,
            previewTtlMs: options.previewTtlMs,
            allowUnverified: options.allowUnverified,
            publishOutbox: options.publishOutbox,
            publishAudit: options.publishAudit,
            runInTransaction: options.runInTransaction,
          }),
        inject: [DATA_SUBJECT_REGISTRY],
      },
    ];

    return {
      module: DataSubjectModule,
      providers,
      exports: [DataSubjectService, DATA_SUBJECT_REGISTRY],
      global: true,
    };
  }
}
