CREATE TABLE "bank_accounts" (
  "tenant_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "id" UUID NOT NULL,
  "label" TEXT NOT NULL CHECK (length(btrim("label")) BETWEEN 1 AND 80),
  "last_four" TEXT CHECK ("last_four" ~ '^[0-9]{4}$'),
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tenant_id", "id")
);
CREATE INDEX "bank_accounts_tenant_id_active_label_id_idx" ON "bank_accounts" ("tenant_id", "active", "label", "id");
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "bank_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY bank_accounts_scope ON "bank_accounts" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT, UPDATE ON "bank_accounts" TO finbridge_app;
