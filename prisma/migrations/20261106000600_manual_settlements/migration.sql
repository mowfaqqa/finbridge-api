ALTER TABLE "invoices" ADD COLUMN "settled_kobo" BIGINT NOT NULL DEFAULT 0
  CHECK ("settled_kobo" BETWEEN 0 AND "total_kobo" AND ("status" = 'ISSUED' OR "settled_kobo" = 0));

CREATE TYPE "settlement_source" AS ENUM ('MANUAL', 'STATEMENT');
CREATE TABLE "settlements" (
  "tenant_id" UUID NOT NULL,
  "id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "source" "settlement_source" NOT NULL,
  "receipt_date" DATE NOT NULL,
  "amount_kobo" BIGINT NOT NULL CHECK ("amount_kobo" BETWEEN 1 AND 1000000000000),
  "reference" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversed_at" TIMESTAMPTZ(3),
  "reversed_by" UUID,
  "reversal_id" UUID,
  "reversal_reason" TEXT,
  PRIMARY KEY ("tenant_id", "id"),
  FOREIGN KEY ("tenant_id", "invoice_id") REFERENCES "invoices"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((reversed_at IS NULL AND reversed_by IS NULL AND reversal_id IS NULL AND reversal_reason IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_id IS NOT NULL AND reversal_reason IS NOT NULL))
);
CREATE UNIQUE INDEX "settlements_tenant_id_reversal_id_key" ON "settlements" ("tenant_id", "reversal_id");
CREATE INDEX "settlements_tenant_id_invoice_id_receipt_date_id_idx" ON "settlements" ("tenant_id", "invoice_id", "receipt_date", "id");

ALTER TABLE "settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY settlements_scope ON "settlements" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT ON "settlements" TO finbridge_app;
GRANT UPDATE (version, reversed_at, reversed_by, reversal_id, reversal_reason) ON "settlements" TO finbridge_app;

CREATE FUNCTION maintain_settled_kobo() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE movement bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'A settlement must be active when recorded' USING ERRCODE = 'check_violation';
    END IF;
    movement := NEW.amount_kobo;
  ELSE
    IF OLD.reversed_at IS NOT NULL OR NEW.reversed_at IS NULL THEN
      RAISE EXCEPTION 'A settlement can only be reversed once' USING ERRCODE = 'check_violation';
    END IF;
    movement := -OLD.amount_kobo;
  END IF;
  UPDATE invoices SET settled_kobo = settled_kobo + movement, version = version + 1
    WHERE tenant_id = NEW.tenant_id AND id = NEW.invoice_id AND status = 'ISSUED'
      AND settled_kobo + movement BETWEEN 0 AND total_kobo;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Settlement exceeds the outstanding balance or invoice is unavailable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_balance AFTER INSERT OR UPDATE ON "settlements" FOR EACH ROW EXECUTE FUNCTION maintain_settled_kobo();
