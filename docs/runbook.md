# FinBridge OS Local Runbook

## Start and verify

Use Node 22 and pnpm 10. Copy the API's environment example to `.env` and the web example to `.env.local`. Start the database and Redis with Compose or use dedicated native services on the ports in the API example. Run the migration with `pnpm db:deploy`. Run `pnpm storage:dev`, `pnpm dev` and `pnpm worker:dev` in separate API terminals. In the web repo, run `pnpm dev` and open http://localhost:3000.

Use `pnpm build && pnpm demo:seed` in the API repo to run the synthetic financing-readiness workflow. The command verifies NGN 85,000 in, NGN 25,000 out, NGN 60,000 net, and NGN 0 open receivables after matching. It also creates an authorised finance operator, a read-only advisor and a downloadable pack.

## Service signals

- API liveness uses `/api/v1/health` and database readiness uses `/api/v1/health/ready`.
- Enable `REQUEST_LOG_ENABLED` for structured route, latency, status and request ID logs. Logs omit request payloads.
- The outbox and worker share the API request ID. Worker logs include queue wait, run time, attempts and safe failure codes. An oldest runnable job above five minutes emits `queue_age_alert`.
- In deployment, route logs to the chosen monitoring service and alert on 5xx above 1% over ten minutes with at least 100 requests. Record the API and job p95 separately.

## Recovery and release

Start the worker after applying additive migrations. A Redis restart preserves the outbox in PostgreSQL and outstanding operations are eligible for redelivery. From the app, retry a failed import or retry a PDF from its saved snapshot. For local verification, stop the standalone worker before running the integration suite against the same database.

Rehearse a restore to an isolated database and object namespace using schema and backup credentials. Restore the database and required objects from the same recovery point. Check health, migrate if necessary, and smoke-test a seeded workspace and authorised PDF. Reapply deletion markers before any future real-data deployment. Pilot objectives are RPO at most 24 hours and RTO at most 4 hours.

The local M3 tag is intended for the two separate repos. Before a public rollout, configure the isolated synthetic fixture environment, disable arbitrary uploads, configure retention cleanup and managed secrets, run the hosted performance and recovery gates, and complete the screen-reader review.

## Local load rehearsal

Create a dedicated empty database named `finbridge_perf` with the same role separation as local development. Apply migrations using that database's `DIRECT_URL`, then run `infra/seed-load.sql` as its fixture administrator. The script creates ten workspaces with 100,000 synthetic entries each. Start a separate API against the benchmark database and point `FINBRIDGE_LOCAL_API_URL` at it. Run `pnpm test:load` to measure 20 sessions performing paginated reads and synchronous expense writes. Run no worker against this fixture database.

Run `pnpm test:async` with the normal local worker and object storage to measure five 10,000-row previews and five evidence renders. Timings include queue wait and status polling. Run this against an isolated synthetic environment.
