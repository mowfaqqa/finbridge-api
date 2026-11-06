-- CreateEnum
CREATE TYPE "import_state" AS ENUM ('UPLOADED', 'VALIDATING', 'REVIEW', 'COMMIT_QUEUED', 'COMMITTED', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "row_disposition" AS ENUM ('KEEP', 'DUPLICATE', 'REVIEW');

-- CreateTable
CREATE TABLE "import_batches" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "created_by" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "object_key" TEXT,
    "raw_digest" TEXT,
    "headers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mapping" JSONB,
    "mapping_digest" TEXT,
    "coverage_start" DATE,
    "coverage_end" DATE,
    "state" "import_state" NOT NULL DEFAULT 'UPLOADED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "accepted_count" INTEGER NOT NULL DEFAULT 0,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "problem_code" TEXT,
    "failed_stage" TEXT,
    "replay_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committed_at" TIMESTAMPTZ(3),

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "booking_date" DATE,
    "description" TEXT,
    "reference" TEXT,
    "source_id" TEXT,
    "amount_kobo" BIGINT,
    "fingerprint" TEXT,
    "content_hash" TEXT,
    "previous_count" INTEGER NOT NULL DEFAULT 0,
    "ambiguous" BOOLEAN NOT NULL DEFAULT false,
    "disposition" "row_disposition" NOT NULL DEFAULT 'KEEP',
    "error" TEXT,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "statement_entries" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "import_row_id" UUID NOT NULL,
    "booking_date" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "reference" TEXT,
    "source_id" TEXT,
    "amount_kobo" BIGINT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,

    CONSTRAINT "statement_entries_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" UUID NOT NULL,
    "target_version" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "event_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" UUID,
    "lease_until" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failure_code" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "import_batches_tenant_id_account_id_coverage_start_coverage_idx" ON "import_batches"("tenant_id", "account_id", "coverage_start", "coverage_end");

-- CreateIndex
CREATE UNIQUE INDEX "import_rows_tenant_id_batch_id_row_number_key" ON "import_rows"("tenant_id", "batch_id", "row_number");

-- CreateIndex
CREATE INDEX "statement_entries_tenant_id_account_id_booking_date_id_idx" ON "statement_entries"("tenant_id", "account_id", "booking_date", "id");

-- CreateIndex
CREATE INDEX "statement_entries_tenant_id_account_id_fingerprint_idx" ON "statement_entries"("tenant_id", "account_id", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "statement_entries_tenant_id_import_row_id_key" ON "statement_entries"("tenant_id", "import_row_id");

-- CreateIndex
CREATE INDEX "outbox_events_completed_at_delivered_at_created_at_id_idx" ON "outbox_events"("completed_at", "delivered_at", "created_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_events_tenant_id_kind_target_id_target_version_key" ON "outbox_events"("tenant_id", "kind", "target_id", "target_version");

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "bank_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "import_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_entries" ADD CONSTRAINT "statement_entries_tenant_id_account_id_fkey" FOREIGN KEY ("tenant_id", "account_id") REFERENCES "bank_accounts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_entries" ADD CONSTRAINT "statement_entries_tenant_id_batch_id_fkey" FOREIGN KEY ("tenant_id", "batch_id") REFERENCES "import_batches"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "statement_entries" ADD CONSTRAINT "statement_entries_tenant_id_import_row_id_fkey" FOREIGN KEY ("tenant_id", "import_row_id") REFERENCES "import_rows"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


CREATE UNIQUE INDEX "import_batches_committed_file" ON "import_batches" (tenant_id, account_id, raw_digest) WHERE state = 'COMMITTED';
CREATE UNIQUE INDEX "statement_entries_stable_source" ON "statement_entries" (tenant_id, account_id, source_id) WHERE source_id IS NOT NULL;
ALTER TABLE "statement_entries" ADD CONSTRAINT "statement_amount_bound"
  CHECK (amount_kobo <> 0 AND amount_kobo BETWEEN -1000000000000 AND 1000000000000);
ALTER TABLE "import_batches" ADD CONSTRAINT "import_size_bound"
  CHECK (bytes BETWEEN 1 AND 5242880 AND row_count BETWEEN 0 AND 10000);
ALTER TABLE "import_batches" ADD CONSTRAINT "import_coverage_order" CHECK (coverage_end >= coverage_start);
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batch_replay_fk"
  FOREIGN KEY (tenant_id, replay_id) REFERENCES "import_batches"(tenant_id, id);
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_workspace_fk" FOREIGN KEY (tenant_id) REFERENCES "workspaces"(id);
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_tenant_event_key" UNIQUE (tenant_id, id);
ALTER TABLE "job_runs" ADD CONSTRAINT "job_run_tenant_event_fk"
  FOREIGN KEY (tenant_id, event_id) REFERENCES "outbox_events"(tenant_id, id);

DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['import_batches', 'import_rows', 'statement_entries', 'job_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO finbridge_app, finbridge_worker USING
      (tenant_id = app_context_uuid(''app.tenant_id'')) WITH CHECK (tenant_id = app_context_uuid(''app.tenant_id''))', relation);
  END LOOP;
END
$$;

ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY outbox_create ON "outbox_events" TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id') AND actor_id = app_context_uuid('app.actor_id'));
CREATE POLICY outbox_relay ON "outbox_events" TO finbridge_worker USING (true) WITH CHECK (true);

CREATE POLICY worker_accounts ON "bank_accounts" FOR SELECT TO finbridge_worker
  USING (tenant_id = app_context_uuid('app.tenant_id'));
CREATE POLICY worker_memberships ON "memberships" FOR SELECT TO finbridge_worker
  USING (tenant_id = app_context_uuid('app.tenant_id') AND user_id = app_context_uuid('app.actor_id'));
CREATE POLICY worker_workspaces ON "workspaces" FOR SELECT TO finbridge_worker
  USING (id = app_context_uuid('app.tenant_id'));
CREATE POLICY worker_audit_append ON "audit_events" FOR INSERT TO finbridge_worker
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id') AND actor_id = app_context_uuid('app.actor_id'));
CREATE POLICY worker_audit_return ON "audit_events" FOR SELECT TO finbridge_worker
  USING (tenant_id = app_context_uuid('app.tenant_id') AND actor_id = app_context_uuid('app.actor_id'));

GRANT SELECT, INSERT, UPDATE ON "import_batches" TO finbridge_app, finbridge_worker;
GRANT SELECT, UPDATE (disposition) ON "import_rows" TO finbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "import_rows" TO finbridge_worker;
GRANT SELECT ON "statement_entries" TO finbridge_app, finbridge_worker;
GRANT INSERT ON "statement_entries" TO finbridge_worker;
GRANT SELECT, INSERT ON "outbox_events" TO finbridge_app;
GRANT SELECT, UPDATE (delivered_at, completed_at) ON "outbox_events" TO finbridge_worker;
GRANT SELECT, INSERT, UPDATE ON "job_runs" TO finbridge_worker;
GRANT SELECT ON "bank_accounts", "memberships", "workspaces" TO finbridge_worker;
GRANT SELECT, INSERT ON "audit_events" TO finbridge_worker;
