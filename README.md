# FinBridge OS API

Standalone NestJS backend for the FinBridge OS SME workspace. The API owns the PostgreSQL schema and publishes its OpenAPI document at `/api/v1/openapi.json`.

Use Node.js 22 and pnpm 10. Copy `.env.example` to `.env`, then run `pnpm install --frozen-lockfile` and `pnpm dev`. The API binds to `127.0.0.1:4000` by default. Configure a local PostgreSQL instance using `DATABASE_URL` for the readiness probe.

- `GET /api/v1/health` checks the API process.
- `GET /api/v1/health/ready` checks PostgreSQL connectivity.
- `pnpm build` generates Prisma Client and compiles the API.

Start the local database with `docker compose up -d --wait postgres`. For a native PostgreSQL installation, create a dedicated `finbridge` database and run `psql -v ON_ERROR_STOP=1 -d finbridge -f infra/local-postgres.sql` as that cluster's administrator. Update the ports in the environment file if needed. The bootstrap passwords in the example are for local development. Use separate schema and runtime credentials in deployed environments.
