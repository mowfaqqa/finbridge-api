-- Run against a dedicated finbridge_perf database using its fixture administrator.
DO $$
BEGIN
  IF current_database() <> 'finbridge_perf' OR EXISTS (SELECT 1 FROM workspaces) THEN
    RAISE EXCEPTION 'Load fixtures require an empty finbridge_perf database';
  END IF;
END
$$;

BEGIN;
INSERT INTO users (id, issuer, subject, verified_email)
  VALUES (gen_random_uuid(), 'urn:finbridge:local', 'owner', 'owner@finbridge.test');
INSERT INTO workspaces (id, slug, display_name)
  SELECT gen_random_uuid(), 'load-' || number, 'Load fixture ' || number FROM generate_series(1, 10) AS number;
INSERT INTO memberships (tenant_id, user_id, role)
  SELECT w.id, u.id, 'OWNER' FROM workspaces w CROSS JOIN users u;
INSERT INTO bank_accounts (tenant_id, id, label)
  SELECT id, gen_random_uuid(), 'Operating' FROM workspaces;

INSERT INTO import_batches
  (tenant_id, id, account_id, created_by, filename, bytes, raw_digest, coverage_start, coverage_end, state, row_count, accepted_count, committed_at)
  SELECT a.tenant_id, gen_random_uuid(), a.id, u.id, 'fixture-' || n || '.csv', 1,
    md5(a.id::text || n) || md5(n || a.id::text), DATE '2026-10-01', DATE '2026-10-31',
    'COMMITTED', 10000, 10000, now()
  FROM bank_accounts a CROSS JOIN users u CROSS JOIN generate_series(1, 10) AS n;

INSERT INTO import_rows (tenant_id, id, batch_id, row_number, booking_date, description, amount_kobo, fingerprint, content_hash)
  SELECT b.tenant_id, gen_random_uuid(), b.id, n + 1, DATE '2026-10-01' + (n % 31),
    'Synthetic statement row ' || n, CASE WHEN n % 2 = 0 THEN 8500 ELSE -2500 END,
    repeat(md5(b.id::text || '/' || n), 2), repeat(md5(b.id::text || '/' || n), 2)
  FROM import_batches b CROSS JOIN generate_series(1, 10000) AS n;

INSERT INTO statement_entries
  (tenant_id, id, account_id, batch_id, import_row_id, booking_date, description, amount_kobo, fingerprint, content_hash)
  SELECT r.tenant_id, gen_random_uuid(), b.account_id, r.batch_id, r.id, r.booking_date, r.description, r.amount_kobo, r.fingerprint, r.content_hash
  FROM import_rows r JOIN import_batches b ON b.tenant_id = r.tenant_id AND b.id = r.batch_id;
COMMIT;
ANALYZE statement_entries;
ANALYZE import_batches;
