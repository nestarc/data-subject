-- Apply in the same schema as DataSubjectRequest and outbox_events.
-- Use a non-owner, NOSUPERUSER, NOBYPASSRLS application role.
CREATE TABLE "DataSubjectDeliveryReceipt" (
  "tenantId" TEXT NOT NULL,
  "notificationId" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenantId", "notificationId"),
  FOREIGN KEY ("requestId") REFERENCES "DataSubjectRequest" (id) ON DELETE CASCADE
);
ALTER TABLE "DataSubjectDeliveryReceipt" ENABLE ROW LEVEL SECURITY;
CREATE POLICY data_subject_delivery_tenant ON "DataSubjectDeliveryReceipt"
  USING ("tenantId" = current_setting('app.current_tenant', true))
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true));
