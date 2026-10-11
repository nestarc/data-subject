# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project currently tracks the shipped behavior of the repository rather than a long release history.

## [Unreleased]

### Changed

- **Breaking:** export includes only `PolicySpec.exportFields`; omitted lists exclude the entity.
- **Breaking:** Prisma executors require `tenantField` or explicit `singleTenantId`; the service validates matching scope and nonblank identifiers before execution.
- **Breaking:** request lookup/update require tenant ID. Request identity fields cannot be patched.
- Erase transaction completion precedes artifact upload and terminal notifications. Callback failure preserves completed data state.
- Failure reasons contain stable codes; `stats.lifecycle` records outcome, stage, recovery direction, and notification failures. Persistence errors expose the request ID for reconciliation.
- Prisma request delegate types accept real generated client types; tested Nest 11 / Prisma 7 peer lines added.

### Added

- Tenant-scoped artifact lookup, optional authenticated actor context, and a fail-closed Nest host example.
- Real PostgreSQL tests using installed npm tarballs for Nest 10.4.22 / Prisma 5.22.0 and Nest 11.2.7 / Prisma 7.10.0 on Node 24.11.1.
- [Migration guide](docs/p0-migration.md) and [exact compatibility matrix](docs/compatibility.md).

## [0.2.0] - 2026-06-19

### Added

- `PrismaRequestStorage` for persistent `DataSubjectRequest` records.
- Stable artifact key helpers for export ZIPs and erase evidence artifacts.
- Erase evidence JSON artifacts stored through `ArtifactStorage`.
- Pre-scan and post-scan erase stats.
- Full audit lifecycle events for request created, processing, completed, and failed paths.
- Typed outbox event payload types.
- `data-subject lint` CLI for Prisma schema/policy checks.
- `lintPrismaSchema(...)`, `formatLintReport(...)`, `shouldFailLint(...)`, and `parsePrismaSchema(...)`.
- `validateRegistry(...)` runtime validation helper.
- `docs/data-subject-0.2.0-feature-proposal.md`.
- `docs/data-subject-0.2.0-spec.md`.

### Changed

- Package version is now `0.2.0`.
- Export artifact keys now use `data-subject/{tenantId}/{requestId}/export.zip`.
- Erase requests now record `artifactUrl` in addition to `artifactHash`.
- Request completion/failure outbox payloads include request type and tenant id.

### Security

- Erase evidence artifacts exclude raw rows and field values by default.
- Failure reasons are normalized before request storage, audit, and outbox publication.

## [0.1.0] - 2026-04-15

Initial public release for the core data-subject workflow.

### Added

- `DataSubjectService` with:
  - `export(subjectId, tenantId)`
  - `erase(subjectId, tenantId)`
  - `getRequest(id)`
  - `listByTenant(tenantId, opts?)`
  - `listOverdue()`
- `DataSubjectModule.forRoot(...)` for NestJS integration
- programmatic entity registration through `Registry`
- policy compilation through `compilePolicy(...)`
- legal-basis validation through `validateLegalBasis(...)`
- `fromPrisma(...)` adapter built on `findMany`, `deleteMany`, and `updateMany`
- `InMemoryRequestStorage`
- `InMemoryArtifactStorage`
- typed runtime errors through `DataSubjectError`

### Implemented Behavior

- export writes one `<EntityName>.json` file per registered entity into a ZIP archive
- export stores the ZIP through `ArtifactStorage.put(...)`
- export records `artifactHash`, `artifactUrl`, and per-entity stats with `strategy: 'export'`
- erase supports `delete`, `anonymize`, and `retain`
- `rowLevel` defaults to `delete-fields`
- mixed `delete` + `retain` entities are downgraded to field-level updates so retain fields are preserved
- erase records per-entity stats, retained field metadata, and verification residuals
- erase publishes `data_subject.erasure_requested`
- export and erase both publish `data_subject.request_completed` and `data_subject.request_failed`
- `runInTransaction` can wrap erase execution in an application-provided unit of work

### Error Model

- added typed error codes for:
  - invalid policy
  - dynamic anonymize replacement
  - verification failure
  - duplicate entity registration
  - request id conflict
  - missing request records

### Limitations

- no decorators or auto-discovery
- no CLI lint or schema inspection tooling
- no built-in persistent request storage adapter
- no built-in persistent artifact storage adapter
- the default Prisma adapter uses `null` for field-level deletes
- erase reports are hashed and stored on the request record, but are not uploaded through `ArtifactStorage`
- `runInTransaction` is only an integration hook; full rollback depends on all participating components sharing the same transaction boundary
