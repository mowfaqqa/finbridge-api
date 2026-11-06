CREATE TABLE "invitations" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "email" TEXT NOT NULL,
  "role" "workspace_role" NOT NULL CHECK ("role" IN ('OPERATOR', 'VIEWER')),
  "token_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "redeemed_at" TIMESTAMPTZ(3),
  "superseded_at" TIMESTAMPTZ(3)
);
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations" ("token_hash");
CREATE INDEX "invitations_tenant_id_email_idx" ON "invitations" ("tenant_id", "email");
CREATE UNIQUE INDEX "invitations_one_pending" ON "invitations" ("tenant_id", "email")
  WHERE "redeemed_at" IS NULL AND "superseded_at" IS NULL;
CREATE UNIQUE INDEX "memberships_one_active_owner" ON "memberships" ("tenant_id")
  WHERE "role" = 'OWNER' AND "revoked_at" IS NULL;

ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY invitation_scope ON "invitations" FOR SELECT TO finbridge_app
  USING (
    tenant_id = app_context_uuid('app.tenant_id')
    OR (app_context_uuid('app.actor_id') IS NOT NULL
      AND email = nullif(current_setting('app.verified_email', true), ''))
  );
CREATE POLICY invitation_insert ON "invitations" FOR INSERT TO finbridge_app
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
CREATE POLICY invitation_update ON "invitations" FOR UPDATE TO finbridge_app
  USING (tenant_id = app_context_uuid('app.tenant_id'))
  WITH CHECK (tenant_id = app_context_uuid('app.tenant_id'));
GRANT SELECT, INSERT, UPDATE ON "invitations" TO finbridge_app;
