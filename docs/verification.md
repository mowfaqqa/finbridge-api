# FinBridge OS M3 Local Verification

## Environment

The 6 November 2026 rehearsal used arm64 macOS 26.6.2, Node.js 22.17, PostgreSQL 14.18, Redis 8.0.3 and local S3-compatible storage. The API, worker and web app ran as separate processes. The load fixture used a separate PostgreSQL database. These measurements describe the local rehearsal.

## Financial workflow

The synthetic SME fixture issued an NGN 85,000 invoice, recorded a manual NGN 35,000 receipt and an NGN 25,000 expense, and published both account statements. Exact replay reused the original import. Reconciliation verified the manual receipt, applied the remaining NGN 50,000, matched the expense, and paired an NGN 20,000 transfer. The resulting report showed NGN 85,000 inflow, NGN 25,000 outflow, NGN 60,000 net and zero open receivables. The worker rendered a complete evidence pack.

## Timing

| Operation | Local result | Profile |
| --- | ---: | --- |
| Paginated statement reads | 107.03 ms p95 | 400 reads, 25 rows per page |
| Synchronous expense writes | 177.80 ms p95 | 400 writes |
| 10,000-row CSV previews | 1.667–1.775 s | Five runs including queue and polling |
| Evidence render | 0.251–1.051 s | Five runs including queue and polling |

The API load run used 20 concurrent sessions over ten tenants with 100,000 committed statement rows each. The five async observations are a local sample. Use the hosted environment to verify the PRD's release percentiles.

## Recovery

A PostgreSQL dump and required private objects were restored into a separate database and local object endpoint. The restored API passed database readiness, reproduced the fixture cash totals and served an authorised PDF with the same SHA-256 digest as the source. The integration suite also verified worker recovery from an injected object-storage read failure.

## Automated checks

The API build and 16 tests passed. The web app passed lint, TypeScript, its production build and two Playwright checks. The browser checks covered axe on sign-in and the live report, owner audit access, the finance operator's pack, keyboard focus and reflow at 320 px. Both production dependency scans and the Gitleaks scans of Git history and staged release changes passed.

## Publication gates

Run the hosted environment checks before publishing. These cover fixture-only access, retention cleanup, operational monitoring, performance and recovery targets, and the manual screen-reader walkthrough. Managed identity provider deployment and GitHub Actions runs use the target repos and environment.
