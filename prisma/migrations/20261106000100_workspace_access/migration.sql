-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "workspace_kind" AS ENUM ('SME', 'BANK');

-- CreateEnum
CREATE TYPE "workspace_role" AS ENUM ('OWNER', 'OPERATOR', 'VIEWER');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "verified_email" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "workspace_kind" NOT NULL DEFAULT 'SME',
    "display_name" TEXT NOT NULL,
    "sector" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "workspace_role" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("tenant_id","user_id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "actor_id" UUID NOT NULL,
    "tenant_id" UUID,
    "outcome" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "version" INTEGER,
    "request_id" UUID NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_issuer_subject_key" ON "users"("issuer", "subject");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "memberships_user_id_tenant_id_idx" ON "memberships"("user_id", "tenant_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_created_at_id_idx" ON "audit_events"("tenant_id", "created_at", "id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Setting values are transaction-local. Missing or malformed values resolve to NULL.
CREATE FUNCTION app_context_uuid(name text) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN current_setting(name, true) ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    THEN current_setting(name, true)::uuid END
$$;
REVOKE ALL ON FUNCTION app_context_uuid(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_context_uuid(text) TO finbridge_app, finbridge_worker;

ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;
CREATE POLICY membership_scope ON "memberships" FOR SELECT TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id') OR user_id = app_context_uuid('app.actor_id'));
CREATE POLICY membership_create ON "memberships" FOR INSERT TO finbridge_app
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
CREATE POLICY membership_update ON "memberships" FOR UPDATE TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));

ALTER TABLE "workspaces" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "workspaces" FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_scope ON "workspaces" FOR SELECT TO finbridge_app
  USING (id = app_context_uuid('app.tenant_id') OR EXISTS (
    SELECT 1 FROM "memberships" WHERE tenant_id = id
      AND user_id = app_context_uuid('app.actor_id') AND revoked_at IS NULL
  ));
CREATE POLICY workspace_create ON "workspaces" FOR INSERT TO finbridge_app
  WITH CHECK (id = app_context_uuid('app.tenant_id'));
CREATE POLICY workspace_update ON "workspaces" FOR UPDATE TO finbridge_app
  USING (id = app_context_uuid('app.tenant_id')) WITH CHECK (id = app_context_uuid('app.tenant_id'));

ALTER TABLE "idempotency_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_records" FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_scope ON "idempotency_records" FOR ALL TO finbridge_app
  USING (actor_id = app_context_uuid('app.actor_id')
    AND (tenant_id IS NULL OR tenant_id = app_context_uuid('app.tenant_id')))
  WITH CHECK (actor_id = app_context_uuid('app.actor_id')
    AND (tenant_id IS NULL OR tenant_id = app_context_uuid('app.tenant_id')));

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_read ON "audit_events" FOR SELECT TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'));
CREATE POLICY audit_append ON "audit_events" FOR INSERT TO finbridge_app
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id') AND actor_id = app_context_uuid('app.actor_id'));

GRANT SELECT, INSERT, UPDATE ON "users", "sessions", "workspaces", "memberships" TO finbridge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_records" TO finbridge_app;
GRANT SELECT, INSERT ON "audit_events" TO finbridge_app;
