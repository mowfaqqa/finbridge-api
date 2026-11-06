CREATE TYPE "expense_category" AS ENUM ('SUPPLIES', 'RENT_AND_UTILITIES', 'TRANSPORT', 'PAYROLL', 'FEES', 'OTHER');
CREATE TYPE "expense_status" AS ENUM ('ACTIVE', 'VOID');
CREATE TABLE "expenses" (
  "tenant_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "id" UUID NOT NULL,
  "expense_date" DATE NOT NULL,
  "payee" TEXT NOT NULL CHECK (length(btrim("payee")) BETWEEN 1 AND 120),
  "category" "expense_category" NOT NULL,
  "reference" TEXT,
  "amount_kobo" BIGINT NOT NULL CHECK ("amount_kobo" BETWEEN 1 AND 1000000000000),
  "status" "expense_status" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voided_at" TIMESTAMPTZ(3),
  "void_reason" TEXT,
  PRIMARY KEY ("tenant_id", "id"),
  CHECK (("status" = 'ACTIVE' AND "voided_at" IS NULL AND "void_reason" IS NULL)
    OR ("status" = 'VOID' AND "voided_at" IS NOT NULL AND "void_reason" IS NOT NULL))
);
CREATE INDEX "expenses_tenant_id_expense_date_id_idx" ON "expenses" ("tenant_id", "expense_date", "id");
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "expenses" FORCE ROW LEVEL SECURITY;
CREATE POLICY expenses_scope ON "expenses" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT, UPDATE ON "expenses" TO finbridge_app;
