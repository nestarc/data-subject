# @nestarc/data-subject

`@nestarc/data-subject` is a small NestJS-oriented toolkit for handling data-subject export and erasure requests against subject-scoped data.

Today the package ships:

- a programmatic entity registry
- a `DataSubjectService` for `export`, `erase`, and request lookup
- a `DataSubjectModule.forRoot(...)` integration for NestJS
- a lightweight Prisma adapter built on `findMany`, `deleteMany`, and `updateMany`
- in-memory request and artifact stores for tests and local development
- typed policy validation and typed runtime errors

## Current Scope

Package version: `0.1.0-alpha.0`

This repository currently focuses on the execution core. It does **not** currently ship:

- decorators or automatic entity discovery
- a CLI or schema linter
- persistent request storage adapters
- persistent artifact storage adapters beyond the in-memory implementation
- schema-aware Prisma field deletion beyond `null` assignment

If you need database-specific behavior, you can plug in your own `EntityExecutor`, `RequestStorage`, or `ArtifactStorage`.

## Installation

```bash
npm install @nestarc/data-subject
```

Peer dependencies used by this package:

- `@nestjs/common`
- `@nestjs/core`
- `reflect-metadata`
- `rxjs`
- `@prisma/client` if you use `fromPrisma(...)`

## Quick Start

```ts
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  DataSubjectModule,
  InMemoryArtifactStorage,
  InMemoryRequestStorage,
  fromPrisma,
} from '@nestarc/data-subject';

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
            rowLevel: 'delete-row',
            fields: {
              email: 'delete',
              name: 'delete',
            },
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
              customerEmail: {
                strategy: 'anonymize',
                replacement: '[REDACTED]',
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
        // forward to your outbox publisher
      },
      publishAudit: async (event, data) => {
        // optional hook
      },
    }),
  ],
})
export class AppModule {}
```

Usage:

```ts
const exportRequest = await dataSubject.export('user_123', 'tenant_abc');
const eraseRequest = await dataSubject.erase('user_123', 'tenant_abc');

const sameRequest = await dataSubject.getRequest(exportRequest.id);
const tenantRequests = await dataSubject.listByTenant('tenant_abc');
const overdue = await dataSubject.listOverdue();
```

## Policy Model

Policies are registered per entity and compiled before execution.

### `delete`

```ts
fields: {
  email: 'delete',
}
```

- shorthand `'delete'` is normalized to `{ strategy: 'delete' }`
- entity `rowLevel` defaults to `'delete-fields'`
- with the default Prisma adapter:
  - `'delete-row'` calls `deleteMany`
  - `'delete-fields'` calls `updateMany` and writes `null` into the configured delete fields

### `anonymize`

```ts
fields: {
  email: { strategy: 'anonymize', replacement: '[REDACTED]' },
}
```

- replacements must be static
- function replacements are rejected during policy compilation

### `retain`

```ts
fields: {
  amount: {
    strategy: 'retain',
    legalBasis: 'tax:KR-basic-law-sec85',
    until: '+7y',
  },
}
```

- `legalBasis` is required
- `strictLegalBasis: true` enables `scheme:reference` validation
- `pseudonymize` is part of the type model, but this package does not perform pseudonymization by itself

### Mixed Strategies

When an entity mixes `delete`, `anonymize`, and `retain`, execution is intentionally conservative:

- `retain` fields are preserved
- delete fields are downgraded to field-level updates instead of row deletion
- mixed entities are reported as `strategy: 'mixed'` in erase stats
- retained fields are recorded in `stats.retained`

This prevents `retain` fields from being dropped just because some other fields on the same row are deletable.

## Export Behavior

`DataSubjectService.export(subjectId, tenantId)` does the following:

1. creates a request record
2. reads matching rows from every registered entity
3. writes one JSON file per entity into a ZIP archive
4. stores the ZIP through `ArtifactStorage.put(...)`
5. records:
   - `artifactHash` as a SHA-256 digest of the ZIP bytes
   - `artifactUrl` returned by the artifact storage
   - `stats.entities[]` with `strategy: 'export'`

Current export artifact shape:

- key: `<requestId>.zip`
- contents: `<EntityName>.json` files

## Erase Behavior

`DataSubjectService.erase(subjectId, tenantId)` does the following:

1. creates a request record
2. publishes `data_subject.erasure_requested`
3. executes each registered entity according to its compiled policy
4. records:
   - `stats.entities[]`
   - `stats.retained[]`
   - `stats.verificationResidual[]`
   - `artifactHash` as a SHA-256 digest of the erase report JSON

Important details:

- erase uses `ArtifactStorage` for exports, but **not** for erase reports
- erase verification currently only fails on residual rows after `delete-row`
- field-level delete and anonymize operations keep rows in place by design

## NestJS Integration

`DataSubjectModule.forRoot(...)` accepts:

- `requestStorage`
- `artifactStorage`
- `slaDays`
- `strictLegalBasis`
- `entities`
- `publishOutbox`
- `publishAudit`
- `runInTransaction`

The module exports:

- `DataSubjectService`
- `DATA_SUBJECT_REGISTRY`

## Public API

The package currently exports:

- `DataSubjectService`
- `DataSubjectModule`
- `Registry`
- `compilePolicy`
- `validateLegalBasis`
- `fromPrisma`
- `InMemoryRequestStorage`
- `InMemoryArtifactStorage`
- all public types from `src/types.ts`
- typed errors from `src/errors.ts`

## Events and Hooks

### Outbox Hook

If `publishOutbox` is provided, the built-in service emits:

- `data_subject.request_created`
- `data_subject.erasure_requested`
- `data_subject.request_completed`
- `data_subject.request_failed`

`request_completed` and `request_failed` are emitted for both export and erase requests. `erasure_requested` is erase-only.

### Audit Hook

If `publishAudit` is provided, the built-in service currently emits:

- `data_subject.request_created`

No additional audit lifecycle events are emitted by the current implementation.

## Typed Errors

The package exposes `DataSubjectError` with stable error codes.

Currently used codes include:

- `dsr_invalid_policy`
- `dsr_anonymize_dynamic_replacement`
- `dsr_verification_failed`
- `dsr_entity_already_registered`
- `dsr_request_conflict`
- `dsr_request_not_found`

Some additional codes exist in the public enum for future or adapter-specific use.

## Transaction Boundaries

`runInTransaction` is an integration hook, not an automatic rollback guarantee.

```ts
new DataSubjectService({
  // ...
  runInTransaction: async (work) => myUnitOfWork.run(work),
});
```

Use it when your erase flow can run inside a real unit-of-work that also covers:

- the entity executors
- request storage writes
- outbox publishing

If those components do not participate in the same transaction boundary, rollback remains best-effort.

## Practical Limitations

The current implementation is intentionally small. A few things are important to know up front:

- `fromPrisma(...)` only depends on `findMany`, `deleteMany`, and `updateMany`
- default Prisma field deletion writes `null`; it does not inspect schema nullability
- request states include `validating`, but the built-in service currently transitions through `created -> processing -> completed|failed`
- there is no built-in subject existence check before export or erase
- only in-memory request and artifact adapters are included in this repository

## Development

```bash
npm test
npm run build
```

## Related Docs

- [docs/prd.md](docs/prd.md)
- [docs/spec.md](docs/spec.md)
- [docs/compliance.md](docs/compliance.md)
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT
