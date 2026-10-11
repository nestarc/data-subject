# Verified compatibility and PostgreSQL example

The compatibility suite installs an `npm pack` tarball into a fresh consumer project, generates a real Prisma client, compiles the consumer with strict TypeScript, boots a Nest testing module, and runs against PostgreSQL. It never imports this repository's `src` files.

## Test matrix

The representative combinations are pinned in `test/compatibility/*/package-lock.json`:

| Profile | Nest common/core/testing | Prisma CLI/client | Node | TypeScript | Database |
| --- | --- | --- | --- | --- | --- |
| `nest10-prisma5` | 10.4.22 | 5.22.0 | 24.11.1 | 5.9.3 | PostgreSQL 16.15 |
| `nest11-prisma7` | 11.2.7 | 7.10.0, `@prisma/adapter-pg` 7.10.0 | 24.11.1 | 5.9.3 | PostgreSQL 16.15 |

Both profiles passed the full P0/P1/P2 suite locally on 2026-10-11 with a macOS arm64 Node process and PostgreSQL in an isolated Linux arm64 Docker container. The run used the stores' default bounded serialization retry settings, including the different SQLSTATE representations observed in Prisma 5 and Prisma 7. The GitHub Actions jobs below are configured for repeatable Linux validation; this local run does not claim that a remote CI run has completed.

The baseline Node 20/22 unit/build CI remains; Node 24 is also checked. The packed PostgreSQL CI uses Node 24.11.1. Peer ranges allow Nest 10, Nest 11.2.7+, Prisma 5, and Prisma 7.10.0+ within those majors, but **the table lists the combinations actually exercised**. Cross-pairing these versions is not separately tested.

Nest 12, Prisma 6/8, other database engines, browser runtimes, native ESM consumer projects, and older Prisma 7 or Nest 11 releases are outside this verification matrix. Prisma 7 has its own Node version requirements and requires a driver adapter; consult [Prisma's system requirements](https://docs.prisma.io/docs/orm/reference/system-requirements) and [Prisma 7 upgrade guide](https://docs.prisma.io/docs/orm/v6/more/upgrades/to-v7) before selecting a different runtime. The package's broad Node engine range does not override dependency requirements.

## Run locally

Use a disposable PostgreSQL database. The test creates a uniquely named schema per profile and drops that schema after success or failure. It does not reset the database's public schema.

```sh
npm ci
docker run --rm -d --name data-subject-compat-db \
  -e POSTGRES_USER=data_subject \
  -e POSTGRES_PASSWORD=data_subject_test \
  -e POSTGRES_DB=data_subject \
  -p 127.0.0.1:54329:5432 postgres:16-alpine

# Wait until the database reports ready.
docker exec data-subject-compat-db pg_isready -U data_subject -d data_subject

DATABASE_URL='postgresql://data_subject:data_subject_test@127.0.0.1:54329/data_subject' \
  npm run test:compatibility

docker stop data-subject-compat-db
```

Pass `-- nest10-prisma5` or `-- nest11-prisma7` to select one profile. Set `KEEP_COMPATIBILITY_WORKSPACE=1` to retain the generated consumer for inspection; otherwise temporary files are removed. npm installation requires registry access. Test credentials above are for this disposable local database only.

The executable consumer is generated from `test/compatibility/smoke.ts.in`, `p1.ts.in`, `p2.ts.in`, and `models.prisma`. It demonstrates:

- `DataSubjectModule.forRoot()` and dependency injection through a real Nest module.
- Direct generated Prisma delegates in `fromPrisma()` and `PrismaRequestStorage`, without casting away their types.
- Explicit tenant filters and export field allowlists. A password hash and access token are present in the database but absent from the ZIP.
- Two tenants sharing a subject ID: export, erasure, request lookup, and artifact lookup stay within the selected tenant.
- Row deletion, field nullification, legal retention, persisted request metadata, ZIP hashing, and erasure evidence.
- Real PostgreSQL rollback when a later entity violates a primary-key constraint after an earlier entity has been deleted.
- A completion callback failure after commit, with data remaining erased and request state remaining completed.
- Signed read-only previews, expiry/signature/tenant rejection, and changed policy/data plans that cannot perform deletion.
- One shared policy definition for runtime and strict schema lint, including new scalar coverage, nullable writes, declared order, cycle rejection, and cascading retention conflicts.
- Stable row identity verification for no-op updates, retention corruption, and subject-key replacement. The PostgreSQL transaction rolls back earlier writes when verification fails.
- Real Prisma DateTime, Decimal, and BigInt values verified after static JSON-compatible replacements in both durable and paged erasure. Coverage includes initially NULL fields, Decimal number/string inputs, BigInt safe-number/large-integer-string inputs, retained Decimal values, and another tenant's unchanged rows.
- Child-before-parent deletion against actual PostgreSQL `RESTRICT` foreign keys while preserving another tenant's rows.
- Composite foreign-key detachment by nulling one nullable component while keeping the required tenant key and retained child amount. Strict lint accepts this policy, and the real database erasure succeeds.
- Strict lint rejects parent referenced-key anonymization that would cascade into a retained child field through `ON UPDATE CASCADE`. A rolled-back database transaction confirms that the fixture's actual foreign key has that cascading behavior.
- Persistent request uniqueness across six concurrent identical calls; a different payload conflicts, while another tenant or request type has a separate key scope.
- The packaged P1 SQL migration applied to an existing request table, including its partial artifact-expiry index.
- Artifact upload and notification recovery in a fresh Node process whose business executors throw if called. Recovery uses the exact committed bytes and hash.
- Abrupt child-process exit before commit (business rows and outbox roll back) and after commit (completion resumes without repeating deletion).
- A completion callback querying committed request state through a separate database connection, and an expired retry payload that is cleared and cannot be uploaded again.
- The packaged P2 queue migration, concurrent submission deduplication, and two workers using `FOR UPDATE SKIP LOCKED`: a second worker completes another job while the first row remains locked.
- Business writes, chunk inserts, and checkpoints rolling back together after a handler failure or rejected oversized chunk. Explicit retry and partial cancellation preserve already committed pages.
- Abrupt worker process exit during a batch, followed by lock release and checkpoint recovery in a new worker.
- Paged export and verified erasure of 1,025 rows per tenant, with at most 64 rows returned per read and 7,704 bytes in the largest observed export chunk. The configured chunk limit is 32,768 bytes. Export queries omit secret fields; another tenant and retained values remain unchanged.
- The full generated Prisma schema passed to paged policy validation, with explicit reasons excluding unrelated workflow and P1 fixture models. A row inserted above the captured upper ID bound is excluded from that export.
- No-op batch updates and oversized export records failing without a committed page or chunk. Expired chunks reject initial and mid-stream reads plus retries. A 1,005-chunk fixture verifies that the first cleanup sweep removes 1,000 chunks, clears private job JSON, and leaves the job eligible for another sweep; subsequent cleanup removes the remainder while retaining deduplication tombstones.
- A Transcend adapter using a real synthetic ES384 signature and trusted tenant mapping, with an injected HTTP transport. An independent P1 erasure commit survives a subsequent queue checkpoint rollback; cancellation remains partial, replay uses the original durable key, and a 503-to-200 callback retry performs only one erasure.

The rollback example uses `AsyncLocalStorage` to resolve entity delegates against the interactive transaction client. `runInTransaction` alone cannot make delegates bound to the root Prisma client transactional. Keep callback side effects separate from database rollback guarantees; an external message already sent cannot be rolled back by PostgreSQL.

The P1 fixture adds `DataSubjectExecution` and uses `PrismaExecutionStore` with `bindTransaction` routing every business delegate to that same client. When using a custom schema, set `executionSchemaName` as well as the Prisma datasource/adapter schema; the row-lock SQL must address the same table. Apply the durable schema migration before enabling this path. The tests exercise bounded operations in one PostgreSQL database, not distributed transactions or arbitrary external executors.

The test's file-backed artifact implementation exists only to carry fixture bytes between child processes. Use the [private S3-compatible example](private-artifacts.md) for an application integration and configure separate export/evidence retention. Completion delivery is at least once; a callback recipient must deduplicate the stable delivery ID.

The P2 row and chunk measurements verify bounded operations, not a heap/RSS benchmark or a cross-page snapshot. The paged path supports independent models only; inserts below the saved upper ID bound and concurrent updates require the host's documented consistency policy. See [P2 execution and recovery](p2-execution.md) for the operational limits. The provider fixture uses synthetic credentials and injected responses, without contacting a real Transcend tenant; [platform integration](platform-integration.md) records that boundary. The separate [Nestarc composition fixture](nestarc-composition.md) covers tenancy, transactional audit/outbox delivery, and durable receipt deduplication.

## Prisma 7 setup differences

The baseline example at `prisma/schema.example.prisma` uses Prisma 5 syntax. For Prisma 7, the fixture generates the following configuration and keeps the same `DataSubjectRequest` model:

```prisma
generator client {
  provider     = "prisma-client"
  output       = "./generated/client"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}
```

```ts
// prisma.config.ts — used by the Prisma CLI
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'schema.prisma',
  datasource: { url: process.env.DATABASE_URL! },
});
```

```ts
import { PrismaClient } from './generated/client/client';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});
```

If using a custom PostgreSQL schema, also pass `{ schema: 'your_schema' }` as the second `PrismaPg` argument, as the test runner does. Authentication, subject verification, durable artifact storage, and operational retry handling remain application responsibilities; the database fixture is an integration example, not a deployable privacy portal.
