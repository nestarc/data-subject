-- PostgreSQL queue. Apply in the same database as the business models.
-- Keep payload/checkpoint/chunks private; hosts must set a retention cleanup schedule.
CREATE TABLE "DataSubjectJob" (
  "id" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued' CHECK ("state" IN ('queued', 'completed', 'failed', 'cancelled')),
  "checkpoint" JSONB NOT NULL DEFAULT 'null',
  "result" JSONB NOT NULL DEFAULT 'null',
  "processedRows" BIGINT NOT NULL DEFAULT 0 CHECK ("processedRows" >= 0),
  "pagesCommitted" INTEGER NOT NULL DEFAULT 0 CHECK ("pagesCommitted" >= 0),
  "chunksWritten" INTEGER NOT NULL DEFAULT 0 CHECK ("chunksWritten" >= 0),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "revision" INTEGER NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "hasCommittedChanges" BOOLEAN NOT NULL DEFAULT false,
  "lastError" TEXT,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "availableAt" TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  "completedAt" TIMESTAMPTZ,
  "chunksDeletedAt" TIMESTAMPTZ,
  "expiresAt" TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '7 days'),
  "purgedAt" TIMESTAMPTZ,
  CONSTRAINT "DataSubjectJob_tenant_kind_key" UNIQUE ("tenantId", "kind", "idempotencyKey")
);
CREATE INDEX "DataSubjectJob_ready_idx" ON "DataSubjectJob" ("availableAt", "createdAt", "id")
  WHERE "state" = 'queued';
CREATE INDEX "DataSubjectJob_expiry_idx" ON "DataSubjectJob" ("expiresAt", "id")
  WHERE "purgedAt" IS NULL;
CREATE TABLE "DataSubjectJobChunk" (
  "jobId" TEXT NOT NULL REFERENCES "DataSubjectJob"("id") ON DELETE CASCADE,
  "tenantId" TEXT NOT NULL,
  "index" INTEGER NOT NULL CHECK ("index" >= 0),
  "body" BYTEA NOT NULL,
  PRIMARY KEY ("jobId", "index")
);
