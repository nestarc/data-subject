-- Apply after the DataSubjectRequest model exists. Match @@map names if customized.
-- The JSON record can contain an export ZIP; restrict access and expire it explicitly.
CREATE TABLE "DataSubjectExecution" (
  "requestId" TEXT PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "record" JSONB NOT NULL,
  CONSTRAINT "DataSubjectExecution_requestId_fkey" FOREIGN KEY ("requestId")
    REFERENCES "DataSubjectRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "DataSubjectExecution_tenantId_type_idempotencyKey_key"
    UNIQUE ("tenantId", "type", "idempotencyKey")
);

-- Keep expiry batches metadata-only and avoid scanning completed records.
-- Prisma schema syntax does not represent expression/partial indexes; retain this
-- statement in the migration if subsequent migrations are generated with Prisma.
CREATE INDEX "DataSubjectExecution_pending_artifact_expiry_idx"
  ON "DataSubjectExecution" (("record"->'artifact'->>'expiresAt'), "requestId")
  WHERE "record"->'artifact'->>'bodyBase64' IS NOT NULL
    AND "record"->>'phase' <> 'completed';
