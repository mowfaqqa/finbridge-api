CREATE TABLE "customers" (
  "tenant_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "id" UUID NOT NULL,
  "display_name" TEXT NOT NULL CHECK (length(btrim("display_name")) BETWEEN 1 AND 120),
  "email" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tenant_id", "id")
);
CREATE INDEX "customers_tenant_id_display_name_id_idx" ON "customers" ("tenant_id", "display_name", "id");

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY customers_scope ON "customers" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT, UPDATE ON "customers" TO finbridge_app;
