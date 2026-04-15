# @nestarc/data-subject

DPA-ready GDPR/CCPA toolkit for NestJS + Prisma. Entity registry, export/erase lifecycle, legal retention, outbox fan-out.

## What this library is NOT

This library rejects three common compliance mistakes:

- "Hashing userId satisfies GDPR erasure" because pseudonymized data is still personal data
- "Soft delete (`deletedAt`) equals GDPR deletion" because the original data is still recoverable
- "Anonymization and pseudonymization are the same" because they are not

The `pseudonymize: 'hmac'` option exists as a defense-in-depth security measure, not as a substitute for erasure. See [`docs/compliance.md`](docs/compliance.md) for details.

## Install

```bash
npm install @nestarc/data-subject
```

## Quickstart

```typescript
import { Module } from '@nestjs/common';
import {
  DataSubjectModule,
  InMemoryArtifactStorage,
  InMemoryRequestStorage,
  fromPrisma,
} from '@nestarc/data-subject';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

@Module({
  imports: [
    DataSubjectModule.forRoot({
      requestStorage: new InMemoryRequestStorage(),
      artifactStorage: new InMemoryArtifactStorage(),
      slaDays: 30,
      strictLegalBasis: true,
      entities: [
        {
          policy: {
            entityName: 'User',
            subjectField: 'userId',
            fields: { email: 'delete', name: 'delete' },
          },
          executor: fromPrisma({
            delegate: prisma.user,
            subjectField: 'userId',
            tenantField: 'tenantId',
          }),
        },
        {
          policy: {
            entityName: 'Invoice',
            subjectField: 'customerId',
            fields: {
              customerName: {
                strategy: 'retain',
                legalBasis: 'tax:KR-basic-law-sec85',
                until: '+7y',
              },
              amount: {
                strategy: 'retain',
                legalBasis: 'tax:KR-basic-law-sec85',
              },
            },
          },
          executor: fromPrisma({
            delegate: prisma.invoice,
            subjectField: 'customerId',
            tenantField: 'tenantId',
          }),
        },
      ],
      publishOutbox: async (type, payload) => {
        /* hand off to @nestarc/outbox */
      },
    }),
  ],
})
export class AppModule {}
```

### Process a request

```typescript
const exportRequest = await dataSubject.export('user_123', 'tenant_abc');
// exportRequest.artifactUrl, exportRequest.artifactHash

const eraseRequest = await dataSubject.erase('user_123', 'tenant_abc');
// eraseRequest.stats.retained holds rows kept under legal basis
```

## Transactional Guarantees

`erase()` is only fully rollbackable when your executors, request storage, and outbox publisher all participate in the same transaction boundary.

By default, the library does **not** guarantee automatic rollback after a late failure such as verification or downstream publishing. To tighten this, pass `runInTransaction` and bind it to your application's transaction mechanism.

```typescript
DataSubjectModule.forRoot({
  // ...
  runInTransaction: async (work) => prisma.$transaction(async () => work()),
});
```

This hook is an integration point, not magic. If your executors or storage adapters do not actually use the same transactional resource, rollback is still best-effort.

## Docs

- [`docs/prd.md`](docs/prd.md) Product requirements
- [`docs/spec.md`](docs/spec.md) Technical spec
- [`docs/compliance.md`](docs/compliance.md) DPA Q&A and legal basis templates

## License

MIT
