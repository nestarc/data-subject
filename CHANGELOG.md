# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project currently tracks the shipped behavior of the repository rather than a long release history.

## [0.1.0-alpha.0] - 2026-04-15

Initial public alpha for the core data-subject workflow.

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
