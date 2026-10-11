# Verified compatibility and PostgreSQL example

The compatibility suite installs an `npm pack` tarball into a fresh consumer project, generates a real Prisma client, compiles the consumer with strict TypeScript, boots a Nest testing module, and runs against PostgreSQL. It never imports this repository's `src` files.

## Test matrix

The representative combinations are pinned in `test/compatibility/*/package-lock.json`:

| Profile | Nest common/core/testing | Prisma CLI/client | Node | TypeScript | Database |
| --- | --- | --- | --- | --- | --- |
| `nest10-prisma5` | 10.4.22 | 5.22.0 | 24.11.1 | 5.9.3 | PostgreSQL 16.15 |
| `nest11-prisma7` | 11.2.7 | 7.10.0, `@prisma/adapter-pg` 7.10.0 | 24.11.1 | 5.9.3 | PostgreSQL 16.15 |

Both profiles passed locally on 2026-10-11 with a macOS arm64 Node process and PostgreSQL in an isolated Linux arm64 Docker container. The GitHub Actions jobs below are configured for repeatable Linux validation; this local run does not claim that a remote CI run has completed.

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

The executable consumer is generated from `test/compatibility/smoke.ts.in` and `models.prisma`. It demonstrates:

- `DataSubjectModule.forRoot()` and dependency injection through a real Nest module.
- Direct generated Prisma delegates in `fromPrisma()` and `PrismaRequestStorage`, without casting away their types.
- Explicit tenant filters and export field allowlists. A password hash and access token are present in the database but absent from the ZIP.
- Two tenants sharing a subject ID: export, erasure, request lookup, and artifact lookup stay within the selected tenant.
- Row deletion, field nullification, legal retention, persisted request metadata, ZIP hashing, and erasure evidence.
- Real PostgreSQL rollback when a later entity violates a primary-key constraint after an earlier entity has been deleted.
- A completion callback failure after commit, with data remaining erased and request state remaining completed.

The rollback example uses `AsyncLocalStorage` to resolve entity delegates against the interactive transaction client. `runInTransaction` alone cannot make delegates bound to the root Prisma client transactional. Keep callback side effects separate from database rollback guarantees; an external message already sent cannot be rolled back by PostgreSQL.

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
