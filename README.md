# @nestarc/data-subject

`@nestarc/data-subject` is a small NestJS-oriented toolkit for handling data-subject export and erasure requests against subject-scoped data.

Today the package ships:

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

Package version: `0.2.0`. The working tree includes unreleased P0/P1/P2 changes; the migration notes below apply to this source build, not the published 0.2.0 tarball.

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
npm install @nestarc/data-subject
```

Peer dependencies used by this package:

- `@nestjs/common`
- `@nestjs/core`
- `reflect-metadata`
- `rxjs`
- `@prisma/client` if you use `fromPrisma(...)`

See the [verified compatibility matrix](docs/compatibility.md), [P0 migration guide](docs/p0-migration.md), and [P1 setup/migration guide](docs/p1-migration.md) for tested versions and API changes.

The [P2 execution guide](docs/p2-execution.md) covers job migrations, batch boundaries, resumable NDJSON, cancellation, and retention. The [Transcend guide](docs/platform-integration.md) describes the optional erasure connector; [nestarc composition](docs/nestarc-composition.md) records the pinned integration and its transaction boundaries. These additions have synthetic verification; live provider accounts and customer workload validation remain separate.

## Quick Start

This example uses Prisma 5 client initialization. The compatibility guide includes the Prisma 7 generator and driver-adapter setup. Before exposing service calls over HTTP, connect authentication, authorization, and subject verification as shown in the [tenant-safe host example](https://github.com/nestarc/data-subject/tree/main/examples/tenant-safe).

```ts
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  DataSubjectModule,
  InMemoryArtifactStorage,
  PrismaRequestStorage,
  fromPrisma,
} from '@nestarc/data-subject';

const prisma = new PrismaClient();
const artifactStorage = new InMemoryArtifactStorage(); // local/dev only; use private durable storage in production

@Module({
  imports: [
    DataSubjectModule.forRoot({
      requestStorage: new PrismaRequestStorage({
        delegate: prisma.dataSubjectRequest,
      }),
      artifactStorage,
      slaDays: 30,
      strictLegalBasis: true,
      entities: [
        {
          policy: {
            entityName: 'User',
            subjectField: 'userId',
            exportFields: ['email', 'name'],
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
            exportFields: ['customerName', 'customerEmail', 'amount'],
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

The quick start uses the immediate execution path. For durable idempotency and completion recovery, configure `PrismaExecutionStore` with transaction-bound delegates as shown in the [P1 guide](docs/p1-migration.md).

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

`DataSubjectService.erase(subjectId, tenantId)` does the following:

1. creates a request record
2. transitions the request to `processing`
3. performs a pre-scan for registered entities
4. publishes `data_subject.erasure_requested`
5. executes each registered entity according to its compiled policy
6. performs a post-scan and residual verification
7. after the transaction resolves, stores an erase evidence JSON artifact through `ArtifactStorage.put(...)`
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

The package currently exports:

- `DataSubjectService`
- `DataSubjectModule`
- `Registry`
- `compilePolicy`
- `validateLegalBasis`
- `fromPrisma`
- `InMemoryRequestStorage`
- `InMemoryArtifactStorage`
- `PrismaRequestStorage`
- `lintPrismaSchema`
- `validateRegistry`
- all public types from `src/types.ts`
- typed errors from `src/errors.ts`

## Schema Lint

The package includes a small Prisma schema linter:

```bash
npx @nestarc/data-subject lint --schema prisma/schema.prisma --config data-subject.config.json
```

Use `definePolicy()` once and consume the same definitions in `Registry.registerDefinition()` and the lint config. Shared definitions enable strict scalar coverage and declared relation checks by default: new fields need a policy or an exclusion reason; required-field null writes, unsafe parent deletion or reference-key updates, retained-child conflicts, missing dependencies, and cycles fail validation. The parser supports a documented Prisma subset; also run `prisma validate`. See the [shared-policy example](docs/p1-migration.md).

## Events and Hooks

### Outbox Hook

If `publishOutbox` is provided, the built-in service emits:

- `data_subject.request_created`
- `data_subject.request_processing` through the audit hook
- `data_subject.erasure_requested`
- `data_subject.request_completed`
- `data_subject.request_failed`

`request_completed` and `request_failed` are emitted for both export and erase requests. `erasure_requested` is erase-only.

### Audit Hook

If `publishAudit` is provided, the built-in service currently emits:

- `data_subject.request_created`
- `data_subject.request_processing`
- `data_subject.request_completed`
- `data_subject.request_failed`

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
- `dsr_invalid_state_transition`
- `dsr_evidence_report_invalid`

Some additional codes exist in the public enum for future or adapter-specific use.

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

The optional `PrismaExecutionStore` path reserves `(tenantId, type, requestKey)` with a unique constraint and uses Serializable transactions to commit entity changes, request stats, retry payload, and notification intents together. After data commit, artifact/status preparation commits before external notification delivery. Callbacks receive a stable third-argument delivery ID and must deduplicate it. External delivery is at least once, not exactly once. All executors must use the store's supplied transaction client.

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

Preview signatures bind subject, tenant, policy, row-scope fingerprints, and expiry. Default TTL is five minutes; provide a shared signing key across instances. Policy or data drift requires a fresh preview. Stable IDs allow verification even when a subject field is anonymized.

Duplicates reuse their stored request; a different payload under the same key is rejected. An already failed data execution is not rerun. Failed uploads retain the original bytes for recovery, then clear those bytes when upload completion is committed. The default DB retry-payload TTL is 24 hours per request type; configure `artifactRetryTtlMs` separately from remote file retention. Schedule the privileged `expirePendingArtifacts(limit)` worker to erase expired DB payloads. See the [P1 guide](docs/p1-migration.md) for schema migration, binding, recovery, and limits.

## Failure and Completion Contract

Inspect `request.stats.lifecycle` as well as `request.state`:

| Failure | Data outcome | Recovery direction |
| --- | --- | --- |
| Created/processing callbacks | `not_started` | Fix the dependency before considering another request |
| Data execution / transaction | `unknown` | Inspect actual data and rollback outcome |
| Evidence preparation / upload after execution | `completed` | Recover the original artifact payload; do not repeat erase |
| Completion status persistence | `completed` | Reconcile stored request, data, and artifact |
| Terminal outbox/audit callback | Completion state is preserved | Inspect `notificationFailures` and recover delivery only |

The service persists an `unknown` checkpoint before data work. If request persistence becomes unavailable, `DataSubjectPersistenceError` exposes `requestId`, `tenantId`, `dataOutcome`, and `recovery: 'reconcile_request'` without the provider's raw error. Use that ID to reconcile before attempting another erase. Failure metadata contains error codes rather than raw database/provider messages.

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
npm test -- --runInBand
npm run lint
npm run build
# With a disposable PostgreSQL DATABASE_URL:
npm run test:compatibility
```

## CI and Release

GitHub Actions is configured with two workflows:

- `CI`: validates on Node 20/22/24 and installs packed tarballs in two PostgreSQL-backed Nest/Prisma consumer profiles on Node 24.11.1
- `Release`: runs the same validation suite and then publishes to npm when a GitHub Release is published

Release expectations:

- configure npm Trusted Publisher for GitHub Actions:
  - organization/user: `nestarc`
  - repository: `data-subject`
  - workflow filename: `release.yml`
  - environment: `npm`
- publish a GitHub Release from a tag that matches `v<package.json version>`
- prerelease versions publish with npm dist-tag `next`
- stable versions such as `0.2.0` publish with npm dist-tag `latest`

## Related Docs

- [P1 setup and migration](docs/p1-migration.md)
- [Private artifacts and retention](docs/private-artifacts.md)

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
