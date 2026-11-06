CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'VOID');
CREATE TABLE "invoices" (
  "tenant_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "id" UUID NOT NULL,
  "customer_id" UUID NOT NULL,
  "customer_snapshot" JSONB,
  "issue_date" DATE NOT NULL,
  "due_date" DATE NOT NULL CHECK ("due_date" >= "issue_date"),
  "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
  "total_kobo" BIGINT NOT NULL CHECK ("total_kobo" BETWEEN 1 AND 1000000000000),
  "issued_number" BIGINT CHECK ("issued_number" > 0),
  "issued_at" TIMESTAMPTZ(3),
  "void_reason" TEXT,
  "voided_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "customer_id") REFERENCES "customers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK (("status" = 'DRAFT' AND "issued_number" IS NULL AND "issued_at" IS NULL AND "customer_snapshot" IS NULL)
    OR ("status" <> 'DRAFT' AND "issued_number" IS NOT NULL AND "issued_at" IS NOT NULL AND "customer_snapshot" IS NOT NULL)),
  CHECK (("status" = 'VOID' AND "void_reason" IS NOT NULL AND "voided_at" IS NOT NULL)
    OR ("status" <> 'VOID' AND "void_reason" IS NULL AND "voided_at" IS NULL))
);
CREATE UNIQUE INDEX "invoices_tenant_id_issued_number_key" ON "invoices" ("tenant_id", "issued_number");
CREATE INDEX "invoices_tenant_id_status_due_date_id_idx" ON "invoices" ("tenant_id", "status", "due_date", "id");
CREATE INDEX "invoices_tenant_id_issue_date_id_idx" ON "invoices" ("tenant_id", "issue_date", "id");
CREATE TABLE "invoice_lines" (
  "tenant_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "position" INTEGER NOT NULL CHECK ("position" BETWEEN 1 AND 50),
  "description" TEXT NOT NULL CHECK (length(btrim("description")) BETWEEN 1 AND 500),
  "quantity" INTEGER NOT NULL CHECK ("quantity" BETWEEN 1 AND 9999),
  "unit_kobo" BIGINT NOT NULL CHECK ("unit_kobo" BETWEEN 0 AND 1000000000000),
  PRIMARY KEY ("tenant_id", "invoice_id", "position"),
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "invoice_counters" (
  "tenant_id" UUID PRIMARY KEY REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "last_number" BIGINT NOT NULL CHECK ("last_number" > 0)
);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['invoices', 'invoice_lines', 'invoice_counters'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO finbridge_app USING
      (tenant_id = app_context_uuid(''app.tenant_id'')) WITH CHECK (tenant_id = app_context_uuid(''app.tenant_id''))', relation);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO finbridge_app', relation);
  END LOOP;
END
$$;
GRANT DELETE ON "invoice_lines" TO finbridge_app;

CREATE FUNCTION keep_issued_invoice_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (
    (NEW.tenant_id, NEW.id, NEW.customer_id, NEW.customer_snapshot, NEW.issue_date, NEW.due_date, NEW.total_kobo, NEW.issued_number, NEW.issued_at)
      IS DISTINCT FROM
    (OLD.tenant_id, OLD.id, OLD.customer_id, OLD.customer_snapshot, OLD.issue_date, OLD.due_date, OLD.total_kobo, OLD.issued_number, OLD.issued_at)
    OR NEW.status = 'DRAFT' OR (OLD.status = 'VOID' AND NEW IS DISTINCT FROM OLD)
  ) THEN
    RAISE EXCEPTION 'Issued invoice content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER issued_invoice_immutable BEFORE UPDATE ON "invoices" FOR EACH ROW EXECUTE FUNCTION keep_issued_invoice_immutable();

CREATE FUNCTION keep_issued_lines_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' AND NOT EXISTS (SELECT 1 FROM invoices WHERE
    tenant_id = OLD.tenant_id AND id = OLD.invoice_id AND status = 'DRAFT') THEN
    RAISE EXCEPTION 'Issued invoice lines are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP <> 'DELETE' AND NOT EXISTS (SELECT 1 FROM invoices WHERE
    tenant_id = NEW.tenant_id AND id = NEW.invoice_id AND status = 'DRAFT') THEN
    RAISE EXCEPTION 'Issued invoice lines are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER issued_lines_immutable BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION keep_issued_lines_immutable();
