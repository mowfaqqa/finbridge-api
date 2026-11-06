-- CreateTable
CREATE TABLE "reconciliation_matches" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "expense_id" UUID,
    "settlement_id" UUID,
    "actor_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "reversed_at" TIMESTAMPTZ(3),
    "reversed_by" UUID,
    "reversal_reason" TEXT,

    CONSTRAINT "reconciliation_matches_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "line_allocations" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "match_id" UUID NOT NULL,
    "released_at" TIMESTAMPTZ(3),

    CONSTRAINT "line_allocations_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateIndex
CREATE INDEX "reconciliation_matches_tenant_id_entry_id_created_at_id_idx" ON "reconciliation_matches"("tenant_id", "entry_id", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_matches_tenant_id_id_entry_id_key" ON "reconciliation_matches"("tenant_id", "id", "entry_id");

-- CreateIndex
CREATE INDEX "line_allocations_tenant_id_entry_id_released_at_idx" ON "line_allocations"("tenant_id", "entry_id", "released_at");

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "statement_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_tenant_id_expense_id_fkey" FOREIGN KEY ("tenant_id", "expense_id") REFERENCES "expenses"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "reconciliation_matches_tenant_id_settlement_id_fkey" FOREIGN KEY ("tenant_id", "settlement_id") REFERENCES "settlements"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_allocations" ADD CONSTRAINT "line_allocations_tenant_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "entry_id") REFERENCES "statement_entries"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "line_allocations" ADD CONSTRAINT "line_allocations_tenant_id_match_id_entry_id_fkey" FOREIGN KEY ("tenant_id", "match_id", "entry_id") REFERENCES "reconciliation_matches"("tenant_id", "id", "entry_id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "match_has_one_target"
  CHECK (num_nonnulls(expense_id, settlement_id) = 1);
ALTER TABLE "reconciliation_matches" ADD CONSTRAINT "match_reversal_complete"
  CHECK (num_nonnulls(reversed_at, reversed_by, reversal_reason) IN (0, 3));
CREATE UNIQUE INDEX "match_active_expense" ON "reconciliation_matches" (tenant_id, expense_id)
  WHERE expense_id IS NOT NULL AND reversed_at IS NULL;
CREATE UNIQUE INDEX "match_active_settlement" ON "reconciliation_matches" (tenant_id, settlement_id)
  WHERE settlement_id IS NOT NULL AND reversed_at IS NULL;
CREATE UNIQUE INDEX "one_active_statement_allocation" ON "line_allocations" (tenant_id, entry_id) WHERE released_at IS NULL;

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['reconciliation_matches', 'line_allocations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO finbridge_app USING
      (tenant_id = app_context_uuid(''app.tenant_id'')) WITH CHECK (tenant_id = app_context_uuid(''app.tenant_id''))', relation);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO finbridge_app', relation);
  END LOOP;
END
$$;
GRANT UPDATE (reversed_at, reversed_by, reversal_reason, version) ON "reconciliation_matches" TO finbridge_app;
GRANT UPDATE (released_at) ON "line_allocations" TO finbridge_app;
