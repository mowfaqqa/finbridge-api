-- CreateEnum
CREATE TYPE "artifact_state" AS ENUM ('QUEUED', 'READY', 'FAILED');

-- CreateTable
CREATE TABLE "evidence_snapshots" (
    "tenant_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "rules_version" TEXT NOT NULL,
    "as_of" TIMESTAMPTZ(3) NOT NULL,
    "incomplete" BOOLEAN NOT NULL,
    "checksum" TEXT NOT NULL,
    "inputs" JSONB NOT NULL,

    CONSTRAINT "evidence_snapshots_pkey" PRIMARY KEY ("tenant_id","id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "tenant_id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "state" "artifact_state" NOT NULL DEFAULT 'QUEUED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "object_key" TEXT,
    "digest" TEXT,
    "bytes" INTEGER,
    "expires_at" TIMESTAMPTZ(3),
    "problem_code" TEXT,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("tenant_id","snapshot_id")
);

-- CreateIndex
CREATE INDEX "evidence_snapshots_tenant_id_as_of_id_idx" ON "evidence_snapshots"("tenant_id", "as_of", "id");

-- CreateIndex
CREATE INDEX "artifacts_tenant_id_state_expires_at_idx" ON "artifacts"("tenant_id", "state", "expires_at");

-- AddForeignKey
ALTER TABLE "evidence_snapshots" ADD CONSTRAINT "evidence_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_tenant_id_snapshot_id_fkey" FOREIGN KEY ("tenant_id", "snapshot_id") REFERENCES "evidence_snapshots"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "artifacts" ADD CONSTRAINT "ready_artifact_has_object" CHECK (
  state <> 'READY' OR (object_key IS NOT NULL AND digest IS NOT NULL AND bytes > 0 AND expires_at IS NOT NULL)
);
DO $$
DECLARE relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['evidence_snapshots', 'artifacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', relation);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', relation);
    EXECUTE format('CREATE POLICY tenant_scope ON %I TO finbridge_app, finbridge_worker USING
      (tenant_id = app_context_uuid(''app.tenant_id'')) WITH CHECK (tenant_id = app_context_uuid(''app.tenant_id''))', relation);
  END LOOP;
END
$$;
GRANT SELECT, INSERT ON "evidence_snapshots", "artifacts" TO finbridge_app;
GRANT UPDATE (state, version, problem_code) ON "artifacts" TO finbridge_app;
GRANT SELECT ON "evidence_snapshots", "artifacts" TO finbridge_worker;
GRANT UPDATE ON "artifacts" TO finbridge_worker;
