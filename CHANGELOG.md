# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Unreleased tracks changes after the latest versioned section. Versioned notes describe release contents; tagging and npm publication are separate release steps.

## [Unreleased]

## [0.3.0] - 2026-10-11

This pre-1.0 minor release includes breaking changes from 0.2.0 and the P0/P1/P2 improvements below. Before upgrading, follow the [P0 migration guide](docs/p0-migration.md) for export allowlists, tenant scope, and request-storage contracts, and the [P1 migration guide](docs/p1-migration.md) for stable-ID verification and optional durable execution. Apply the separate [P2 migrations](docs/p2-execution.md) only when enabling the job queue. The tenant-safe example's policy helpers move from `entities` to `definitions`.

### Fixed

- ZIP exports serialize BigInt values as exact decimal strings, including nested allowlisted values.
- Both erase runners verify Prisma DateTime, Decimal, and BigInt replacements against their stored scalar values while retaining strict comparison for retained fields.
- Relation lint accepts composite foreign-key detachment when one nullable component is cleared, and detects retained-child conflicts when a parent reference key changes through `onUpdate`.
- The compiled CLI loads `.mjs` policy configurations with native ES module imports, including top-level await and paths containing spaces.
- Private S3 download links use a fixed signing timestamp and are withheld if their validity expires while signing.
- Benchmark reads and rollback snapshots independently copy Date and Decimal values so mutations cannot change expected results or saved rollback state.
- The tenant-safe host forwards actor/subject-scoped durable request keys, preserves reconciliation details, and rejects unsupported idempotency claims before execution.
- Nestarc completion workers record their verified `system` or `api_key` actor type instead of being logged as users, while preserving the original requester.

### P2

- Transcend erasure webhook adapter with pinned ES384 verification, trusted tenant/subject mapping, encrypted callback nonces, durable job submission, and separate local/provider outcomes.
- Optional PostgreSQL job queue with bounded transactions, atomic page checkpoints, concurrent workers, retry limits, cancellation, partial completion, and expiring private chunks.
- Paged Prisma erasure and allowlisted NDJSON export for independent models, using stable keyset cursors and bounded high-water marks. Previously committed batches remain committed after cancellation or later failure.
- Pinned nestarc tenancy/audit-log/outbox composition example and consumer validation, with durable delivery receipts rather than assuming an outbox metadata key enforces uniqueness.
- Synthetic workload and failure fixtures, deployment guidance, and a support proposal that separates tested technical scope from unvalidated customer adoption and pricing hypotheses.

### P1

- Signed, read-only erasure previews with expiry and in-transaction policy/scope revalidation.
- Shared serializable policy definitions, strict scalar coverage, required-field/null checks, declared relation/order/retention validation, and immutable registry snapshots.
- **Breaking:** erasure requires stable scalar identity and `selectByIds` verification by default; explicit legacy compatibility records unverified results.
- Evidence v2 records actual strategy, policy hash, field verification status, and sanitized verification failures.
- Optional `PrismaExecutionStore` with tenant/type/key uniqueness, atomic data/request/outbox persistence, and original-byte completion recovery. Add the `DataSubjectExecution` model/migration before enabling it.
- Stable notification delivery IDs, bounded serialization retries, retry-payload expiration, and an administrative expiry worker.
- Private S3 storage reference with distinct export/evidence retention, access checks, presigning, immutable retries, and cleanup.
- Packed PostgreSQL consumer tests for concurrency, rollback, commit interruption, and fresh-process recovery on Prisma 5 and 7.

### Changed

- Update GitHub Actions to checkout 7.0.1 and setup-node 7.1.0, pinned to verified commit SHAs, and add Node 26 to the CI matrix while retaining the declared Node 20 compatibility check and pinned PostgreSQL profiles.
- Require the complete reusable CI workflow before npm publication; validate release metadata before installing dependencies, scope OIDC permission to the publish job, and use npm 12.2.0 with safe environment-based tag handling. PostgreSQL fixture installers now share the restored npm cache, keyed by their lockfiles.
- Tenant-safe policy helpers now return `{ definition, executor }` for the module's `definitions` option instead of `entities`; the example includes matching schema coverage and nullable-write checks.
- Benchmarks use current shared policies and strict verification, exact total row counts, validated arguments, fresh fixtures, and assertions outside the measurement interval. Coverage includes signed previews, Prisma scalar replacements, and paged NDJSON/erasure.
- Private artifact examples use the public API and document failed-evidence preservation, original-byte recovery, and separate S3/P1/P2 retention workflows.
- README setup, public API, event, and validation guidance now covers the current source build. Package metadata describes concrete execution capabilities, and npm archives include this changelog and the implementation roadmap.
- **Breaking:** export includes only `PolicySpec.exportFields`; omitted lists exclude the entity.
- **Breaking:** Prisma executors require `tenantField` or explicit `singleTenantId`; the service validates matching scope and nonblank identifiers before execution.
- **Breaking:** request lookup/update require tenant ID. Request identity fields cannot be patched.
- Erase transaction completion precedes artifact upload and terminal notifications. Callback failure preserves completed data state.
- Failure reasons contain stable codes; `stats.lifecycle` records outcome, stage, recovery direction, and notification failures. Persistence errors expose the request ID for reconciliation.
- Prisma request delegate types accept real generated client types; tested Nest 11 / Prisma 7 peer lines added.

### Added

- Tenant-safe host routes for signed previews and owner-checked completion recovery, optional required-preview configuration, artifact-specific permissions, and content-type/SHA-256 verification before delivery.
- `bench:check`, `bench:smoke`, and `examples:check`, CI coverage for benchmark/example checks, and example sources included in lint. The generated-client Nestarc example remains covered by the separate pinned PostgreSQL composition fixture.
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
