# @nestarc/data-subject

`@nestarc/data-subject` is a small NestJS-oriented toolkit for handling data-subject export and erasure requests against subject-scoped data.

The current source build provides:

- a programmatic entity registry and a shared JSON policy definition for runtime/lint
- a `DataSubjectService` for `export`, `erase`, and request lookup
- a `DataSubjectModule.forRoot(...)` integration for NestJS
- a lightweight Prisma adapter built on `findMany`, `deleteMany`, and `updateMany`
- a `PrismaRequestStorage` adapter for persistent request records
- in-memory request and artifact stores for tests and local development
- signed read-only erasure previews, stable-ID field verification, and v2 evidence
- optional PostgreSQL idempotency, transactional execution records, and resumable artifact/notification delivery
- a PostgreSQL job queue with resumable pages, cancellation, and bounded NDJSON export
- an optional Transcend erasure webhook adapter with separate local and provider status
- a `data-subject lint` CLI for Prisma schema/policy checks
- explicit export field allowlists and tenant-scoped request/artifact access
- failure-stage metadata that distinguishes committed data from delivery failures
- typed policy validation and typed runtime errors

## Current Scope

Package version: `0.3.0`. This pre-1.0 release includes breaking changes from `0.2.0`, together with P0/P1/P2, benchmark, and example improvements recorded in the [changelog](CHANGELOG.md). Follow the migration guides below when upgrading. These instructions describe the 0.3.0 source build; use matching release documentation for older tarballs.

This repository focuses on the execution core plus the minimum production trust layer. It does **not** currently ship:

- decorators or automatic entity discovery
- a core cloud-storage dependency; a private S3 reference implementation is provided separately
- direct Stripe, Intercom, analytics, or support-tool connectors
- an admin or end-user portal
- automatic relation discovery/deletion or distributed transactions
- streaming ZIP archives; the separate paged export path streams NDJSON chunks

If you need database-specific behavior, you can plug in your own `EntityExecutor`, `RequestStorage`, or `ArtifactStorage`.

## Installation

```bash
# Once 0.3.0 is available in your registry:
npm install @nestarc/data-subject@0.3.0
```

To validate this checkout before publication, run `npm ci && npm run build && npm pack` and install the resulting `nestarc-data-subject-0.3.0.tgz` into your application. Updating repository metadata does not publish an npm release.

Node.js 20 or newer is required; the chosen Prisma/Nest versions may impose stricter requirements. Peer dependencies used by this package:

- `@nestjs/common`
- `@nestjs/core`
- `reflect-metadata`
- `rxjs`
- `@prisma/client` if you use `fromPrisma(...)`

See the [verified compatibility matrix](docs/compatibility.md), [P0 migration guide](docs/p0-migration.md), and [P1 setup/migration guide](docs/p1-migration.md) for tested versions and API changes.

The [P2 execution guide](docs/p2-execution.md) covers job migrations, batch boundaries, resumable NDJSON, cancellation, and retention. The [Transcend guide](docs/platform-integration.md) describes the optional erasure connector; [nestarc composition](docs/nestarc-composition.md) records the pinned integration and its transaction boundaries. These additions have synthetic verification; live provider accounts and customer workload validation remain separate.

## Quick Start

This example uses Prisma 5 client initialization. Merge `DataSubjectRequest` and its related `DataSubjectExecution` model from [the Prisma schema example](prisma/schema.example.prisma), plus the [User model fragment](https://github.com/nestarc/data-subject/blob/main/examples/tenant-safe/schema.example.prisma), into your application schema, apply your migration, and regenerate the client. The User fragment has an immutable `id`, `userId`, `tenantId`, and four nullable personal-data fields. The P2 job models are only needed when enabling that path. The compatibility guide includes Prisma 7 generator and driver-adapter setup.

Define one policy for runtime registration and schema lint:

```ts
// policy.ts
import { definePolicy } from '@nestarc/data-subject';

export const definitions = definePolicy([{
  entityName: 'User',
  subjectField: 'userId',
  stableIdField: 'id',
  scope: { mode: 'multi-tenant', tenantField: 'tenantId' },
  rowLevel: 'delete-fields',
  fields: {
    email: 'delete',
    displayName: 'delete',
    passwordHash: 'delete',
    sessionToken: 'delete',
  },
  exportFields: ['email', 'displayName'],
  ignoredFields: {
    id: 'Immutable identity used for post-write verification',
    userId: 'Subject lookup key retained while personal fields are cleared',
    tenantId: 'Tenant boundary retained on every read and write',
  },
}]);
```

```ts
// app.module.ts
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  DataSubjectModule,
  InMemoryArtifactStorage,
  PrismaRequestStorage,
  fromPrisma,
} from '@nestarc/data-subject';
import { definitions } from './policy';

const prisma = new PrismaClient();

@Module({
  imports: [DataSubjectModule.forRoot({
    requestStorage: new PrismaRequestStorage({ delegate: prisma.dataSubjectRequest }),
    artifactStorage: new InMemoryArtifactStorage(), // local development only
    slaDays: 30,
    definitions: [{
      definition: definitions[0],
      executor: fromPrisma({
        delegate: prisma.user,
        subjectField: 'userId',
        tenantField: 'tenantId',
        stableIdField: 'id',
      }),
    }],
  })],
})
export class AppModule {}
```

This quick start uses immediate execution without a transaction hook and does not promise rollback. Before exposing HTTP routes, connect authentication, authorization, subject verification, and private storage through the [tenant-safe host example](https://github.com/nestarc/data-subject/tree/main/examples/tenant-safe). For signed-preview execution, bind all delegates to a Serializable transaction; for durable idempotency and completion recovery, configure `PrismaExecutionStore` as shown in the [P1 guide](docs/p1-migration.md).

For tests and local development, `InMemoryRequestStorage` and `InMemoryArtifactStorage` are still available. Do not use in-memory storage for production request history or evidence retention.

Usage:

```ts
// IDs come from the host's authenticated, authorized, verified context.
const exportRequest = await dataSubject.export('user_123', 'tenant_abc', { requestedBy: 'actor_123' });
const eraseRequest = await dataSubject.erase('user_123', 'tenant_abc', { requestedBy: 'actor_123' });

const sameRequest = await dataSubject.getRequest(exportRequest.id, 'tenant_abc');
// Also check sameRequest.subjectId against the authorized caller before download.
const artifact = await dataSubject.getArtifact(exportRequest.id, 'tenant_abc');
const tenantRequests = await dataSubject.listByTenant('tenant_abc');
const overdue = await dataSubject.listOverdue(); // privileged background administration only
```

Multi-tenant mode is the default: every executor must declare tenant scope, and `fromPrisma` requires a `tenantField`. A single-tenant installation must instead pass the same explicit `singleTenantId` to both `fromPrisma` and the service/module. Blank identifiers and mismatched scope are rejected before execution. Custom executors must actually enforce their declared filters.

## Policy Model

Policies are registered per entity and compiled before execution. Prefer shared `definePolicy()` definitions with the module’s `definitions` option or `Registry.registerDefinition()` so runtime and lint consume the same policy. The legacy `entities`/`Registry.register()` API remains available.

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
- `strictLegalBasis: true` enables `scheme:reference` format validation; the host decides the applicable basis
- `until` is retention metadata, not a scheduler that automatically deletes data when the date passes
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
2. reads matching rows only from entities with a nonempty `exportFields` allowlist
3. projects only explicitly listed, own top-level fields into each entity JSON file in the ZIP
4. stores the ZIP through `ArtifactStorage.put(...)`
5. records:
   - `artifactHash` as a SHA-256 digest of the ZIP bytes
   - `artifactUrl` returned by the artifact storage
   - `stats.entities[]` with `strategy: 'export'`

`exportFields` is separate from erase `fields`. Omitted or empty lists exclude the entity entirely. Newly added columns, password hashes, and tokens are excluded unless explicitly listed. Selecting a JSON/object field includes its nested content; review those values separately.

BigInt values are exported as exact decimal strings, including inside nested values. Dates use ISO strings through JSON serialization. Consumers should preserve decimal strings when values can exceed JavaScript's safe integer range.

Current export artifact shape:

- key: `data-subject/{tenantId}/{requestId}/export.zip`
- contents: `<EntityName>.json` files

## Erase Behavior

On the immediate path, `DataSubjectService.erase(subjectId, tenantId)` does the following (the durable callback ordering is described under Transaction Boundaries):

1. creates a request record
2. transitions the request to `processing`
3. performs a pre-scan for registered entities
4. publishes `data_subject.erasure_requested`
5. executes each registered entity according to its compiled policy
6. performs a post-scan and residual verification
7. after data execution and any configured transaction resolve, stores an erase evidence JSON artifact through `ArtifactStorage.put(...)`
8. records:
   - `stats.entities[]`
   - `stats.retained[]`
   - `stats.verificationResidual[]`
   - `stats.preScan[]`
   - `stats.postScan[]`
   - `artifactHash` as a SHA-256 digest of the erase evidence artifact
   - `artifactUrl` returned by the artifact storage

Important details:

- erase evidence artifacts intentionally exclude raw rows and field values
- erasure requires a stable scalar row ID and tenant-scoped `selectByIds`; `fromPrisma` defaults to `id`
- verification checks deleted rows, nullified fields, exact replacement values, and retained values after all entities execute
- evidence v2 includes policy hash, actual strategy, field verification status, and sanitized failure information
- field-level delete and anonymize operations keep rows in place by design
- `subjectId` is not written into the default erase evidence artifact; it remains connected through the request record

## NestJS Integration

`DataSubjectModule.forRoot(...)` accepts:

- `requestStorage`
- `artifactStorage`
- `slaDays`
- `singleTenantId` (explicit single-tenant mode; omit for multi-tenant)
- `strictLegalBasis`
- `entities` or shared `definitions`
- `previewSigningKey`, `previewTtlMs`
- `durableStore`, `artifactRetryTtlMs`
- `allowUnverified` (explicit legacy-only compatibility)
- `publishOutbox`
- `publishAudit`
- `runInTransaction`

The module exports:

- `DataSubjectService`
- `DATA_SUBJECT_REGISTRY`

## Public API

The root entry point `@nestarc/data-subject` exposes these APIs and their associated TypeScript types:

| Area | Main exports |
| --- | --- |
| Service and Nest module | `DataSubjectService`, `DataSubjectModule`, `DATA_SUBJECT_REGISTRY`, `RequestContext` |
| Shared policy | `Registry`, `definePolicy`, `validateDefinition`, `compilePolicy`, `hashRegistryPolicy`, `validateLegalBasis` |
| Preview and verification | `ErasurePreview`, `ErasureVerificationError`, `buildErasureEvidenceArtifact` |
| Prisma and storage | `fromPrisma`, `PrismaRequestStorage`, `PrismaExecutionStore`, `InMemoryRequestStorage`, `InMemoryArtifactStorage`, `RequestStorage`, `ArtifactStorage` |
| Artifact identity | `exportArtifactKey`, `erasureEvidenceArtifactKey`, `sha256Hex` |
| Schema validation | `lintPrismaSchema`, `parsePrismaSchema`, `formatLintReport`, `shouldFailLint`, `validateRegistry` |
| Paged jobs | `PostgresJobStore`, `pagedFromPrisma`, `createPagedPrivacyHandler`, `createPagedPrivacyPayload`, `PAGED_PRIVACY_JOB_KIND` |
| Transcend integration | `TranscendErasureAdapter`, `TranscendIntegrationError`, `TRANSCEND_ERASURE_JOB` |
| Core errors | `DataSubjectError`, `DataSubjectErrorCode`, `DataSubjectPersistenceError` |

The `@nestarc/data-subject/lint` subpath also exposes the lint API. Private S3 and Nestarc composition integrations are repository examples, not additional package export paths.

## Schema Lint

The package includes a small Prisma schema linter:

```bash
# data-subject.config.cjs imports definitions from the compiled policy.ts above.
npx data-subject lint --schema prisma/schema.prisma --config data-subject.config.cjs
```

For that config, reuse the application’s compiled policy:

```js
// data-subject.config.cjs
const { definitions } = require('./dist/policy.js');
module.exports = {
  definitions,
  strictCoverage: true,
  checkRelations: true,
  suppressions: [
    { model: 'DataSubjectRequest', reason: 'Request history has separate host access and retention policies' },
    { model: 'DataSubjectExecution', reason: 'Recovery payloads use privileged expiry; execution metadata has separate retention' },
  ],
  // Review and add a specific reason for any other workflow or unrelated model.
};
```

Build `policy.ts` before running the CLI and adapt the compiled path to your application. The suppressions describe separate host responsibilities; they do not implement access control or cleanup. Config files may be `.json`, `.js`, `.cjs`, or `.mjs`; `.mjs` uses native ESM loading, including top-level await.

Use `definePolicy()` once and consume the same definitions in `Registry.registerDefinition()` and the lint config. Shared definitions enable strict scalar coverage and declared relation checks by default: new fields need a policy or an exclusion reason; required-field null writes, unsafe parent deletion or reference-key updates, retained-child conflicts, missing dependencies, and cycles fail validation. The parser supports a documented Prisma subset; also run `prisma validate`. See the [shared-policy example](docs/p1-migration.md).

## Events and Hooks

### Outbox Hook

If `publishOutbox` is provided, the built-in service emits:

- `data_subject.request_created`
- `data_subject.erasure_requested`
- `data_subject.request_completed`
- `data_subject.request_failed`

`request_completed` and `request_failed` are emitted for both export and erase requests. `erasure_requested` is erase-only. `request_processing` belongs to the audit hook, not the outbox hook.

### Audit Hook

If `publishAudit` is provided, the built-in service currently emits:

- `data_subject.request_created`
- `data_subject.request_processing`
- `data_subject.request_completed`
- `data_subject.request_failed`

With durable execution, both hooks also receive `data_subject.artifact_expired` when a pending retry payload expires. Durable callbacks receive a `DeliveryContext` as their third argument; deduplicate its stable `id` because callbacks may be delivered more than once. Callback timing differs between immediate and durable execution, as described below.

## Typed Errors

The package exposes `DataSubjectError` with stable error codes.

Currently used codes include:

- `dsr_invalid_input`
- `dsr_invalid_scope`
- `dsr_request_persistence_failed`
- `dsr_invalid_policy`
- `dsr_anonymize_dynamic_replacement`
- `dsr_verification_failed`
- `dsr_entity_already_registered`
- `dsr_request_conflict`
- `dsr_request_not_found`
- `dsr_artifact_write_failed`
- `dsr_artifact_expired`
- `dsr_plan_mismatch`
- `dsr_plan_expired`
- `dsr_verification_unavailable`
- `dsr_durable_execution_required`
- `dsr_invalid_state_transition`
- `dsr_evidence_report_invalid`

The public enum also contains reserved or adapter-specific codes. `DataSubjectPersistenceError` carries a reconciliation ID; `ErasureVerificationError` carries verification details. Transcend integration failures use the separate `TranscendIntegrationError` type.

## Transaction Boundaries

`runInTransaction` is an integration hook, not an automatic rollback guarantee.

```ts
new DataSubjectService({
  // ...
  runInTransaction: async (work) => myUnitOfWork.run(work),
});
```

The hook wraps erase data reads, mutations, verification, and `erasure_requested`. All executors must resolve their delegates against the same transaction client, and the hook must resolve only after commit. The [packed PostgreSQL fixture](https://github.com/nestarc/data-subject/blob/main/test/compatibility/smoke.ts.in) demonstrates this with `AsyncLocalStorage`.

On the immediate path, request state writes, artifact uploads, and terminal callbacks run outside that transaction. An external message cannot be rolled back by the database.

The optional `PrismaExecutionStore` path reserves `(tenantId, type, requestKey)` with a unique constraint and uses Serializable transactions to commit entity changes, request stats, retry payload, and notification intents together. After data commit, artifact/status preparation commits before external notification delivery. Callbacks receive a `DeliveryContext` as the third argument and must deduplicate its stable `id`. External delivery is at least once, not exactly once. Even created/processing notifications are delivered after durable execution; callbacks cannot approve or cancel those data changes. Perform host authorization before calling the service. All executors must use the store's supplied transaction client.

## Preview and Durable Recovery

```ts
// service is configured with PrismaExecutionStore and transaction-bound executors.
const preview = await service.previewErase(verifiedSubjectId, tenantId);
// Host authorization/approval happens here. No data writes occurred during preview.
const request = await service.erase(verifiedSubjectId, tenantId, {
  requestedBy: actorId,
  requestKey: hostRequestKey,
  preview,
});
// After an artifact or notification failure; never invokes entity operations.
const recovered = await service.retryCompletion(request.id, tenantId);
```

Preview signatures bind subject, tenant, policy, row-scope fingerprints, and expiry. Default TTL is five minutes; provide a shared signing key of at least 32 bytes across instances. Policy or data drift requires a fresh preview. Stable IDs allow verification even when a subject field is anonymized.

Every durable `export` and `erase` requires a `requestKey`. Duplicate calls reuse their stored request; a different payload under the same tenant/type/key is rejected. The payload includes the actor and the entire preview: reuse the original preview and key for a network retry, and use a new approved key for a new plan. An already failed data execution is not rerun. Failed uploads retain the original bytes for recovery, then clear those bytes when upload completion is committed. The default DB retry-payload TTL is 24 hours per request type; configure `artifactRetryTtlMs` separately from remote file retention. Schedule the privileged `expirePendingArtifacts(limit)` worker to erase expired DB payloads. See the [P1 guide](docs/p1-migration.md) for schema migration, binding, recovery, and limits.

A durable execution failure, including an invalid preview, can return a stored `failed` request instead of throwing. Inspect `state`, `failureReason`, `stats.lifecycle`, and `stats.verification`; an HTTP success response alone does not establish erasure success. Failed erasure evidence may be preserved without changing the request to completed.

## Paged Execution

`PostgresJobStore` and the paged privacy handler use separate job IDs and private NDJSON/evidence chunks. Do not pass those IDs to `DataSubjectService.getArtifact()` or the ZIP download examples. This path supports independent models and commits each verified batch with its checkpoint. Later failure or cancellation preserves earlier commits; there is no whole-job rollback or cross-page snapshot. P1 signed previews do not authorize a paged job. See the [P2 execution guide](docs/p2-execution.md) for setup, authorization, retries, consistency, and repeated chunk cleanup.

## Failure and Completion Contract

Inspect `request.stats.lifecycle` as well as `request.state`. This table describes the immediate execution path:

| Failure | Data outcome | Recovery direction |
| --- | --- | --- |
| Created/processing callbacks | `not_started` | Fix the dependency before considering another request |
| Data execution / transaction | `unknown` | Inspect actual data and rollback outcome |
| Evidence preparation / upload after execution | `completed` | Recover the original artifact payload; do not repeat erase |
| Completion status persistence | `completed` | Reconcile stored request, data, and artifact |
| Terminal outbox/audit callback | Completion state is preserved | Inspect `notificationFailures` and recover delivery only |

The immediate service persists an `unknown` checkpoint before data work. If request persistence becomes unavailable, `DataSubjectPersistenceError` exposes `requestId`, `tenantId`, `dataOutcome`, and `recovery: 'reconcile_request'` without the provider's raw error. Use that ID to reconcile before attempting another erase. Failure metadata contains error codes rather than raw database/provider messages.

The immediate path exposes recovery guidance. The configured durable path implements `retryCompletion` for original artifact bytes and pending notifications. It never reruns failed entity work, and expired retry bytes cannot be regenerated by that API. See the [P1 guide](docs/p1-migration.md) for recovery semantics and the [P0 guide](docs/p0-migration.md) for the immediate-path contract.

## Practical Limitations

The current implementation is intentionally small. A few things are important to know up front:

- `fromPrisma(...)` only depends on `findMany`, `deleteMany`, and `updateMany`
- default field deletion writes `null`; schema lint checks nullability before deployment, and does not query live database metadata during execution
- request states include `validating`, but the built-in service currently transitions through `created -> processing -> completed|failed`
- there is no built-in subject existence check before export or erase
- the [private S3 example](docs/private-artifacts.md) covers separate retention, authenticated downloads, signed URLs, and cleanup; real bucket/IAM compatibility must be validated in your environment
- composite row IDs, arbitrary relational graphs, multi-database atomicity, and automatic legal-policy decisions are outside the supported scope

## Development

```bash
npm ci
DATA_SUBJECT_HTTP_FIXTURE=1 npm test -- --runInBand
npm run lint
npm run build
npm run examples:check
# With a disposable PostgreSQL DATABASE_URL:
npm run test:compatibility
npm run test:composition
```

## Examples

The [tenant-safe host](https://github.com/nestarc/data-subject/tree/main/examples/tenant-safe) uses shared policy definitions, signed previews, durable request keys, owner-checked completion recovery, and authenticated artifact delivery. Its policy helpers now return `{ definition, executor }` for the module's `definitions` option; they no longer belong in `entities`. Apply the matching schema checks and transaction wiring described in that example.

`npm run examples:check` type-checks the tenant-safe and private-artifact examples and checks the S3 bridge syntax. Their runtime coverage is part of `npm test`. The [Nestarc composition](docs/nestarc-composition.md) needs generated Prisma 7 types and pinned optional packages, so its strict type check and real database validation run separately via `npm run test:composition`. The local examples check does not substitute for that database test or actual AWS validation.

## Benchmarks

```bash
npm run bench:check
npm run bench:smoke
npm run bench -- --iterations 100 --warmup 10 --rows 1000 --batch-size 128
```

The benchmark measures in-memory execution using the current public APIs, shared policy definitions, and strict schema validation. `--rows` is the exact total target row count for each data scenario; ZIP export distributes that total across five entities, including any remainder. Fixtures also include other tenants and subjects to verify isolation. `--iterations` and `--rows` require positive integers, `--warmup` allows zero, and `--batch-size` accepts 1–1000.

| Scenarios | Measured operation |
| --- | --- |
| A–B | Scoped executor read and five-field policy compilation |
| C–F | Allowlisted ZIP export; verified row deletion, field deletion, and mixed erasure |
| G–I | Signed preview, erasure with a prepared preview, and DateTime/Decimal/BigInt replacement verification |
| P2 | Paged NDJSON export and mixed erasure through the actual handler, with local checkpoints |

Each warmup and measured iteration starts with fresh fixtures. Seeding, registration, schema validation, and post-run assertions are outside the timer; execution includes the library's own verification, artifact creation, fixture reads/writes, and immediate erasure's local snapshot transaction. Reads and snapshots copy Date/Decimal values independently so in-place changes cannot alter the expected data or rollback state. Scenario H prepares its preview before timing. Afterward the benchmark checks actual rows, retained values, tenant/subject isolation, ZIP projection and hash, v2 evidence, and bounded P2 pages. Any failed check exits nonzero. Percentiles use the nearest-rank method over measured iterations only.

These timings include synthetic executor and instrumentation overhead. They do not measure PostgreSQL queue locks, durable transactions, crash recovery, provider callbacks, or storage/network latency. P2 uses a local checkpoint loop and retains chunks and call traces in memory for verification, so it is not a streaming-memory benchmark. No relative speed ordering or timing threshold is asserted; compare repeated runs on the same Node version and hardware. For real database behavior use the [packed compatibility suite](docs/compatibility.md).

## CI and Release

GitHub Actions is configured with two workflows:

- `CI`: runs lint, the full test suite including the local HTTP fixture, build, benchmark checks/smoke tests, and example checks on Node 20/22/24. Separate Node 24.11.1 PostgreSQL jobs exercise two packed Nest/Prisma profiles and the pinned Nestarc composition, including service-actor recovery.
- `Release`: runs lint, unit tests, and the build before publishing to npm when a GitHub Release is published

Release expectations:

- keep package/lockfile versions and the changelog in sync, and complete the compatibility/example checks before tagging a release

- configure npm Trusted Publisher for GitHub Actions:
  - organization/user: `nestarc`
  - repository: `data-subject`
  - workflow filename: `release.yml`
  - environment: `npm`
- publish a GitHub Release from a tag that matches `v<package.json version>`
- prerelease versions publish with npm dist-tag `next`
- non-prerelease versions such as `0.3.0` publish with npm dist-tag `latest`

## Related Docs

- [P1 setup and migration](docs/p1-migration.md)
- [Private artifacts and retention](docs/private-artifacts.md)
- [P2 execution and recovery](docs/p2-execution.md)
- [Transcend integration](docs/platform-integration.md)
- [Pinned Nestarc composition](docs/nestarc-composition.md)
- [Support scope proposal](docs/p2-support-proposal.md)
- [P0 migration guide](docs/p0-migration.md)
- [Verified compatibility and PostgreSQL example](docs/compatibility.md)
- [Authenticated tenant-safe Nest host example](https://github.com/nestarc/data-subject/tree/main/examples/tenant-safe)

- [Market positioning and improvement roadmap](docs/market-positioning-roadmap.md)
- [docs/prd.md](docs/prd.md)
- [docs/spec.md](docs/spec.md)
- [docs/data-subject-0.2.0-feature-proposal.md](docs/data-subject-0.2.0-feature-proposal.md)
- [docs/data-subject-0.2.0-spec.md](docs/data-subject-0.2.0-spec.md)
- [docs/compliance.md](docs/compliance.md)
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT
