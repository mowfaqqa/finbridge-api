# FinBridge OS Architecture and Threat Model

The web app and API have independent Git histories, builds and deployment settings. Browser requests stay on the web origin. Next.js forwards versioned API paths to a NestJS modular monolith. The worker is a separate process that consumes BullMQ jobs using PostgreSQL as the source of workflow state. Private S3 objects hold staged CSVs and rendered PDFs.

## Tenant boundary

Sessions identify the actor. Each workspace request resolves current membership before setting the tenant and actor for a single Prisma transaction. Ordinary tenant tables use forced row-level security and composite foreign keys. The application role cannot bypass row-level security, own the schema, or change audit history. The worker has separate credentials and resolves opaque outbox event IDs. It rechecks the actor and domain state before publishing work.

## Money and publication

Record values use signed BIGINT kobo. Reports sum movements in PostgreSQL NUMERIC and serialise amounts as decimal strings. Invoice totals and active receipts are bounded and balance changes serialize on the invoice row. Statement allocation is exclusive across receipt matches, expense matches and transfer legs. Raw staged data cannot change reports. Publishing commits entries, coverage and audit together.

## Retry and evidence decisions

Commands lock scoped idempotency records. The durable outbox records work before contacting Redis. Redelivery checks the operation state and lease. Evidence generation stores a bounded repeatable-read snapshot and checksum before queueing rendering. PDF reads go through the API with membership, role and expiry checks on every request.

## Threats and controls

| Threat | Control and verification |
| --- | --- |
| Tenant ID or file URL guessing | Active membership and role checks, default-deny RLS, scoped storage keys and authorised downloads. Integration tests use alternating tenant contexts and guessed resource IDs. |
| Replayed commands or competing allocations | Idempotency records, advisory and row locks, durable uniqueness, versions and transaction tests for concurrent issue, receipts and matching. |
| Crafted CSV and forged uploads | Short-lived actor-bound upload tickets, type and size checks, bounded UTF-8 CSV parsing and explicit review before publication. React escapes display text. |
| Session or browser script injection | OIDC signature and protocol checks, HttpOnly and same-site cookies, exact-origin writes, nonce-based CSP and redacted request logs. |
| Broker or worker interruption | Durable outbox, leased attempts, bounded retries and state guards. Local integration tests inject a storage read failure and verify recovery. |
| Stale evidence or revoked access | Versioned snapshots, immutable checksummed inputs, expiring artifacts and per-request authorisation. |
