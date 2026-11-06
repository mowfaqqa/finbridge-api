-- AlterTable
ALTER TABLE "line_allocations" ADD COLUMN     "transfer_id" UUID,
ALTER COLUMN "match_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "internal_transfers" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "debit_entry_id" UUID NOT NULL,
    "credit_entry_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "internal_transfers_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "internal_transfers_tenant_id_debit_entry_id_idx" ON "internal_transfers"("tenant_id", "debit_entry_id");

-- CreateIndex
CREATE INDEX "internal_transfers_tenant_id_credit_entry_id_idx" ON "internal_transfers"("tenant_id", "credit_entry_id");

-- AddForeignKey
ALTER TABLE "line_allocations" ADD CONSTRAINT "line_allocations_tenant_id_transfer_id_fkey" FOREIGN KEY ("tenant_id", "transfer_id") REFERENCES "internal_transfers"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_tenant_id_debit_entry_id_fkey" FOREIGN KEY ("tenant_id", "debit_entry_id") REFERENCES "statement_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "internal_transfers" ADD CONSTRAINT "internal_transfers_tenant_id_credit_entry_id_fkey" FOREIGN KEY ("tenant_id", "credit_entry_id") REFERENCES "statement_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "line_allocations" ADD CONSTRAINT "allocation_has_one_operation"
  CHECK (num_nonnulls(match_id, transfer_id) = 1);
ALTER TABLE "internal_transfers" ADD CONSTRAINT "transfer_distinct_legs" CHECK (debit_entry_id <> credit_entry_id);
ALTER TABLE "internal_transfers" ADD CONSTRAINT "transfer_reversal_complete"
  CHECK (num_nonnulls(reversed_at, reversed_by, reversal_reason) IN (0, 3));
ALTER TABLE "internal_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "internal_transfers" FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_transfers_scope ON "internal_transfers" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT ON "internal_transfers" TO finbridge_app;
GRANT UPDATE (version, reversed_at, reversed_by, reversal_reason) ON "internal_transfers" TO finbridge_app;

CREATE FUNCTION validate_transfer_allocation_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.transfer_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM internal_transfers t WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.transfer_id
      AND NEW.entry_id IN (t.debit_entry_id, t.credit_entry_id)
  ) THEN
    RAISE EXCEPTION 'Allocation must reference a leg of its transfer' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER transfer_allocation_leg BEFORE INSERT ON "line_allocations" FOR EACH ROW EXECUTE FUNCTION validate_transfer_allocation_leg();
