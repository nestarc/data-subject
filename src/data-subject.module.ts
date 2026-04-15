import { DynamicModule, Module, type Provider } from '@nestjs/common';

import {
  DataSubjectService,
  type DataSubjectServiceDeps,
} from './data-subject.service';
import { Registry, type RegisterInput } from './registry';
import type { ArtifactStorage } from './storage/artifact-storage.interface';
import type { RequestStorage } from './storage/request-storage.interface';

export const DATA_SUBJECT_REGISTRY = Symbol('DATA_SUBJECT_REGISTRY');

export interface DataSubjectModuleOptions {
  requestStorage: RequestStorage;
  artifactStorage: ArtifactStorage;
  slaDays?: number;
  strictLegalBasis?: boolean;
  entities?: RegisterInput[];
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
