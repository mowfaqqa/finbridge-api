# FinBridge OS API

Standalone NestJS backend for the FinBridge OS SME workspace. The API owns the PostgreSQL schema and publishes its OpenAPI document at `/api/v1/openapi.json`.

Use Node.js 22 and pnpm 10. Copy `.env.example` to `.env`, then run `pnpm install --frozen-lockfile` and `pnpm dev`. The API binds to `127.0.0.1:4000` by default. Configure a local PostgreSQL instance using `DATABASE_URL` for the readiness probe.

- `GET /api/v1/health` checks the API process.
- `GET /api/v1/health/ready` checks PostgreSQL connectivity.
- `pnpm build` generates Prisma Client and compiles the API.

Start the local database with `docker compose up -d --wait postgres`. For a native PostgreSQL installation, create a dedicated `finbridge` database and run `psql -v ON_ERROR_STOP=1 -d finbridge -f infra/local-postgres.sql` as that cluster's administrator. Update the ports in the environment file if needed. The bootstrap passwords in the example are for local development. Use separate schema and runtime credentials in deployed environments.

## Workspace onboarding

1. Copy `.env.example` to `.env` and start PostgreSQL using the Compose or native instructions above.
2. Run `pnpm db:deploy` as the migration role specified by `DIRECT_URL`.
3. Run `pnpm dev` and open the frontend at http://localhost:3000.
4. Sign in as the synthetic SME owner and create a business workspace.

The local identity picker is enabled by `LOCAL_AUTH_ENABLED=true` and is unavailable in production. Writes require an `Origin` that matches `WEB_ORIGIN`. The application connects as `finbridge_app`, a non-owner role without `BYPASSRLS`.

With a dedicated local or CI database, run `pnpm build && pnpm test:integration`. The tests create synthetic workspaces to verify idempotency, session rotation, tenant isolation and OpenAPI. Export the contract without starting the server with `pnpm --silent api:export` after building.

For local membership testing, invite `operator@finbridge.test` or `viewer@finbridge.test` as the owner. Open the invitation link in a separate browser session and choose its matching local identity. Creating a replacement link invalidates the previous pending link. The link is presented in the UI for the owner to share.
