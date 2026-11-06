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

## Managed OIDC configuration

Set `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and a random `OIDC_FLOW_SECRET` of at least 32 characters to enable managed sign-in. Register `{WEB_ORIGIN}/api/v1/auth/oidc/callback` as an allowed callback on the provider, with the authorization code flow, PKCE S256 and client secret basic authentication. Use an HTTPS issuer and set an HTTPS web origin for production. The provider must return the verified email claim for identity-bound invitations. The local synthetic path works with the four OIDC values unset.

## Statement imports and worker

Start local PostgreSQL and Redis with `docker compose up -d --wait`. For a native Redis installation, use a dedicated instance on loopback port 56379. In separate terminals, run `pnpm storage:dev` for local private S3-compatible storage, `pnpm dev` for the API, and `pnpm worker:dev` for background jobs. The worker uses the separate `finbridge_worker` PostgreSQL role. Run `pnpm db:deploy` after pulling migrations.

The canonical UTF-8 CSV header is `date,description,amount,reference,source_id`. Use an ISO date and a signed NGN amount such as `-25000.01`. Select an account and confirm the inclusive source coverage before validation. Review the staged rows and resolve each ambiguous duplicate before publishing. Reports use published rows and confirmed coverage only.

For integration tests, keep PostgreSQL and Redis running. The tests start an isolated temporary object store and inject a transient read failure to verify worker retry.

## Readiness evidence

Open **Readiness** as an owner or finance operator. Generation captures the current three-month evidence in one database snapshot and queues PDF rendering. The worker embeds IBM Plex Sans from `assets/fonts` under the included OFL license. Keep that directory with the deployed worker. Downloads are authorised per request and expire after 24 hours.
