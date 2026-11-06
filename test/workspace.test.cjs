const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const S3rver = require('s3rver');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../dist/app');
const { ObjectStorage } = require('../dist/platform/storage');
const { startJobs } = require('../dist/jobs/runner');
const { importHandlers } = require('../dist/statements/import-worker');
const { setContext } = require('../dist/platform/transaction');

let app;
let base;
let testStorage;
let storagePath;
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

before(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'finbridge-storage-'));
  testStorage = new S3rver({
    address: '127.0.0.1', port: 0, silent: true, directory: storagePath,
    configureBuckets: [{ name: 'finbridge-test' }],
  });
  const address = await testStorage.run();
  Object.assign(process.env, {
    S3_ENDPOINT: `http://127.0.0.1:${address.port}`, S3_BUCKET: 'finbridge-test',
    S3_ACCESS_KEY: 'S3RVER', S3_SECRET_KEY: 'S3RVER',
  });
  app = await createApp(true);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
  await testStorage?.close();
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

async function request(path, { cookie, body, key, method, requestOrigin = origin } = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      Origin: requestOrigin,
      ...(cookie && { Cookie: cookie }),
      ...(key && { 'Idempotency-Key': key }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn(persona, cookie) {
  const response = await request('/auth/local-session', { cookie, body: { persona } });
  assert.equal(response.status, 201, await response.clone().text());
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  return { cookie: setCookie.split(';')[0], actor: await response.json() };
}

async function createWorkspace(cookie, displayName, key = randomUUID()) {
  const response = await request('/workspaces', { cookie, body: { displayName }, key });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

test('workspace creation is atomic and retry-safe, with fresh tenant authorization', async () => {
  assert.equal((await request('/workspaces')).status, 401);
  const owner = await signIn('owner');
  const other = await signIn('second-owner');
  const key = randomUUID();
  const [first, replay] = await Promise.all([
    createWorkspace(owner.cookie, 'Akoka Studio', key),
    createWorkspace(owner.cookie, 'Akoka Studio', key),
  ]);
  assert.equal(first.id, replay.id);
  assert.equal(first.role, 'OWNER');

  const conflict = await request('/workspaces', { cookie: owner.cookie, body: { displayName: 'Changed' }, key });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, 'IDEMPOTENCY_KEY_REUSED');

  const wrongTenant = await request(`/workspaces/${first.id}`, { cookie: other.cookie });
  assert.equal(wrongTenant.status, 404);
  assert.equal((await request('/workspaces/invalid', { cookie: owner.cookie })).status, 404);
  const listing = await request('/workspaces', { cookie: owner.cookie });
  assert.equal((await listing.json()).filter((row) => row.id === first.id).length, 1);

  const csrf = await request('/workspaces', {
    cookie: owner.cookie, body: { displayName: 'Blocked' }, key: randomUUID(), requestOrigin: 'https://different.example',
  });
  assert.equal(csrf.status, 403);
  assert.equal((await csrf.json()).code, 'ORIGIN_FORBIDDEN');

  const rotated = await signIn('owner', owner.cookie);
  assert.notEqual(rotated.cookie, owner.cookie);
  assert.equal((await request('/auth/session', { cookie: owner.cookie })).status, 401);
  assert.equal((await request('/auth/logout', { cookie: rotated.cookie, method: 'POST' })).status, 204);
  assert.equal((await request('/auth/session', { cookie: rotated.cookie })).status, 401);
});

test('runtime RLS denies missing or malformed context and isolates a reused connection', async () => {
  const one = await signIn('owner');
  const two = await signIn('second-owner');
  const first = await createWorkspace(one.cookie, 'Tenant one');
  const second = await createWorkspace(two.cookie, 'Tenant two');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('connection_limit', '1');
  const db = new PrismaClient({ datasourceUrl: url.href });
  try {
    const [runtime] = await db.$queryRaw`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    assert.deepEqual(runtime, { rolname: 'finbridge_app', rolsuper: false, rolbypassrls: false });
    const [owner] = await db.$queryRaw`SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_events'`;
    assert.notEqual(owner.tableowner, runtime.rolname);

    assert.deepEqual(await db.auditEvent.findMany(), []);
    const scoped = (actor, workspace) => db.$transaction(async (tx) => {
      await setContext(tx, actor.id, workspace.id);
      return tx.auditEvent.findMany({ select: { tenantId: true, action: true } });
    });
    assert.deepEqual(await scoped(one.actor, first), [{ tenantId: first.id, action: 'workspace_created' }]);
    assert.deepEqual(await scoped(two.actor, second), [{ tenantId: second.id, action: 'workspace_created' }]);
    assert.deepEqual(await db.auditEvent.findMany(), []);
    assert.deepEqual(await scoped(one.actor, { id: 'broken-context' }), []);
    await assert.rejects(() => db.$transaction(async (tx) => {
      await setContext(tx, one.actor.id, first.id);
      await tx.auditEvent.updateMany({ data: { action: 'tampered' } });
    }));
  } finally {
    await db.$disconnect();
  }
});

test('OpenAPI publishes workspace write and response contracts', async () => {
  const response = await request('/openapi.json');
  assert.equal(response.status, 200);
  const spec = await response.json();
  const post = spec.paths['/api/v1/workspaces'].post;
  assert.equal(post.requestBody.content['application/json'].schema.properties.displayName.type, 'string');
  assert.equal(post.responses['201'].content['application/json'].schema.properties.role.enum[0], 'OWNER');
  assert.ok(post.parameters.some((parameter) => parameter.name === 'Idempotency-Key' && parameter.required));
});

test('invitations bind verified identity, supersede safely and grant only the selected workspace', async () => {
  const owner = await signIn('owner');
  const operator = await signIn('operator');
  const viewer = await signIn('viewer');
  const workspace = await createWorkspace(owner.cookie, 'Invite test');
  const root = `/workspaces/${workspace.id}`;
  const invite = async (email, role, key = randomUUID()) => {
    const response = await request(`${root}/invitations`, { cookie: owner.cookie, key, body: { email, role } });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const accept = (cookie, token, key = randomUUID()) =>
    request('/invitations/accept', { cookie, key, body: { token } });

  const original = await invite('operator@finbridge.test', 'VIEWER');
  const key = randomUUID();
  const latest = await invite('operator@finbridge.test', 'OPERATOR', key);
  assert.equal((await invite('operator@finbridge.test', 'OPERATOR', key)).token, latest.token);
  assert.equal((await accept(operator.cookie, original.token)).status, 422);
  assert.equal((await accept(viewer.cookie, latest.token)).status, 422);
  const acceptKey = randomUUID();
  const accepted = await accept(operator.cookie, latest.token, acceptKey);
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.deepEqual(await accepted.json(), { ...workspace, role: 'OPERATOR' });
  assert.equal((await accept(operator.cookie, latest.token, acceptKey)).status, 200);
  assert.equal((await accept(operator.cookie, latest.token)).status, 422);
  assert.equal((await request(`${root}/members`, { cookie: operator.cookie })).status, 403);

  const expired = await invite('viewer@finbridge.test', 'VIEWER');
  const db = new PrismaClient();
  try {
    await db.$transaction(async (tx) => {
      await setContext(tx, owner.actor.id, workspace.id);
      await tx.invitation.update({ where: { id: expired.id }, data: { expiresAt: new Date(0) } });
    });
  } finally {
    await db.$disconnect();
  }
  assert.equal((await accept(viewer.cookie, expired.token)).status, 422);

  const revoke = (userId) => request(`${root}/members/${userId}/revoke`, {
    cookie: owner.cookie, key: randomUUID(), body: { version: 1, reason: 'Access removed in test' },
  });
  assert.equal((await revoke(owner.actor.id)).status, 409);
  assert.equal((await revoke(operator.actor.id)).status, 200);
  assert.equal((await request(root, { cookie: operator.cookie })).status, 404);
  assert.equal((await accept(operator.cookie, latest.token, acceptKey)).status, 422);

  const pending = await invite('viewer@finbridge.test', 'VIEWER');
  const transfer = () => request(`${root}/transfer-ownership`, {
    cookie: owner.cookie, key: randomUUID(), body: { version: 1, userId: viewer.actor.id },
  });
  assert.equal((await transfer()).status, 422);
  assert.equal((await accept(viewer.cookie, pending.token)).status, 200);
  const transferred = await transfer();
  assert.equal(transferred.status, 200, await transferred.clone().text());
  assert.equal((await (await request(root, { cookie: viewer.cookie })).json()).role, 'OWNER');
  assert.equal((await request(`${root}/members`, { cookie: owner.cookie })).status, 403);
});

test('customers support stable cursor navigation, versioned writes and viewer read-only access', async () => {
  const owner = await signIn('owner');
  const viewer = await signIn('viewer');
  const other = await signIn('second-owner');
  const workspace = await createWorkspace(owner.cookie, 'Customer records test');
  const root = `/workspaces/${workspace.id}`;
  const invitation = await request(`${root}/invitations`, {
    cookie: owner.cookie, key: randomUUID(), body: { email: viewer.actor.verifiedEmail, role: 'VIEWER' },
  });
  assert.equal(invitation.status, 201);
  assert.equal((await request('/invitations/accept', {
    cookie: viewer.cookie, key: randomUUID(), body: { token: (await invitation.json()).token },
  })).status, 200);
  const list = `${root}/customers`;
  const add = async (name, key = randomUUID()) => {
    const response = await request(list, { cookie: owner.cookie, key, body: { displayName: name } });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const firstKey = randomUUID();
  const first = await add('A Lagos customer', firstKey);
  assert.equal((await add('A Lagos customer', firstKey)).id, first.id);
  const second = await add('B Lagos customer');
  const third = await add('C Abuja customer');
  const page = await (await request(`${list}?q=LAGOS&limit=1`, { cookie: viewer.cookie })).json();
  assert.deepEqual(page, { items: [first], nextCursor: first.id, previousCursor: null });
  const next = await (await request(`${list}?q=LAGOS&limit=1&after=${first.id}`, { cookie: viewer.cookie })).json();
  assert.deepEqual(next, { items: [second], nextCursor: null, previousCursor: second.id });
  const previous = await (await request(`${list}?q=LAGOS&limit=1&before=${second.id}`, { cookie: viewer.cookie })).json();
  assert.deepEqual(previous, page);

  const update = (cookie, email) => request(`${list}/${third.id}`, {
    method: 'PATCH', cookie, key: randomUUID(), body: { version: 1, email },
  });
  assert.equal((await update(viewer.cookie, 'viewer@example.test')).status, 403);
  assert.equal((await request(`${list}/${third.id}`, { cookie: other.cookie })).status, 404);
  const updates = await Promise.all([update(owner.cookie, 'one@example.test'), update(owner.cookie, 'two@example.test')]);
  assert.deepEqual(updates.map((response) => response.status).sort(), [200, 409]);
  const fresh = await (await request(`${list}/${third.id}`, { cookie: viewer.cookie })).json();
  assert.equal(fresh.version, 2);
  assert.ok(fresh.email.endsWith('@example.test'));
});

test('invoice issue preserves exact totals, snapshots, monotonic numbers and idempotency under concurrency', async () => {
  const owner = await signIn('owner');
  const workspace = await createWorkspace(owner.cookie, 'Invoice lifecycle test');
  const root = `/workspaces/${workspace.id}`;
  const command = (path, body, method = 'POST', key = randomUUID()) =>
    request(path, { cookie: owner.cookie, method, key, body });
  const customerResponse = await command(`${root}/customers`, { displayName: 'Original customer', email: 'billing@example.test' });
  assert.equal(customerResponse.status, 201);
  const customer = await customerResponse.json();
  const body = {
    customerId: customer.id, issueDate: '2025-02-01', dueDate: '2025-02-15',
    lines: [{ description: 'Work', quantity: 2, unitKobo: '4250001' }],
  };
  const invoices = `${root}/invoices`;
  assert.equal((await command(invoices, { ...body, dueDate: '2025-01-31' })).status, 422);
  assert.equal((await command(invoices, { ...body, lines: [{ description: 'Bound', quantity: 2, unitKobo: '1000000000000' }] })).status, 422);
  assert.equal((await command(invoices, { ...body, lines: [{ description: 'Fraction', quantity: 1, unitKobo: '10.1' }] })).status, 422);
  const draft = await (await command(invoices, body)).json();
  assert.equal(draft.status, 'DRAFT');
  assert.equal(draft.outstandingKobo, null);
  assert.equal(draft.totalKobo, '8500002');
  assert.equal(draft.currency, 'NGN');

  const issue = (id, key) => command(`${invoices}/${id}/issue`, { version: 1 }, 'POST', key);
  const key = randomUUID();
  const results = await Promise.all([issue(draft.id, key), issue(draft.id, key)]);
  for (const response of results) assert.equal(response.status, 200, await response.clone().text());
  const [issued, replay] = await Promise.all(results.map((response) => response.json()));
  assert.deepEqual(replay, issued);
  assert.equal(issued.number, 'INV-001');
  assert.equal(issued.overdue, true);
  assert.equal(issued.outstandingKobo, '8500002');

  const rename = await command(`${root}/customers/${customer.id}`, { version: 1, displayName: 'Renamed customer' }, 'PATCH');
  assert.equal(rename.status, 200);
  const snapshot = await (await request(`${invoices}/${draft.id}`, { cookie: owner.cookie })).json();
  assert.equal(snapshot.customer.displayName, 'Original customer');
  assert.equal((await command(`${invoices}/${draft.id}`, { ...body, version: 2 }, 'PATCH')).status, 409);

  const nextDrafts = await Promise.all([command(invoices, body), command(invoices, body)]);
  const [two, three] = await Promise.all(nextDrafts.map((response) => response.json()));
  const nextNumbers = await Promise.all([issue(two.id), issue(three.id)]);
  assert.deepEqual((await Promise.all(nextNumbers.map((response) => response.json()))).map((row) => row.number).sort(), ['INV-002', 'INV-003']);

  const db = new PrismaClient();
  try {
    await assert.rejects(() => db.$transaction(async (tx) => {
      await setContext(tx, owner.actor.id, workspace.id);
      await tx.invoiceLine.updateMany({ where: { invoiceId: issued.id }, data: { description: 'Tampered' } });
    }));
  } finally {
    await db.$disconnect();
  }
  assert.equal((await command(`${invoices}/${issued.id}/void`, { version: 2, reason: '' })).status, 422);
  const voided = await command(`${invoices}/${issued.id}/void`, { version: 2, reason: 'Duplicate draft' });
  assert.equal(voided.status, 200, await voided.clone().text());
  const voidView = await voided.json();
  assert.equal(voidView.status, 'VOID');
  assert.equal(voidView.number, 'INV-001');
  assert.equal(voidView.outstandingKobo, null);
});

test('expenses use positive exact kobo and versioned, reasoned voids', async () => {
  const owner = await signIn('owner');
  const workspace = await createWorkspace(owner.cookie, 'Expenses test');
  const root = `/workspaces/${workspace.id}/expenses`;
  const command = (path, body, method = 'POST', key = randomUUID()) =>
    request(path, { cookie: owner.cookie, method, key, body });
  const input = { payee: 'Office supplies', category: 'SUPPLIES', date: '2026-11-01', amountKobo: '2500001' };
  assert.equal((await command(root, { ...input, amountKobo: '0' })).status, 422);
  assert.equal((await command(root, { ...input, date: '2026-02-29' })).status, 422);
  const key = randomUUID();
  const created = await command(root, input, 'POST', key);
  assert.equal(created.status, 201, await created.clone().text());
  const expense = await created.json();
  assert.equal(expense.amountKobo, '2500001');
  assert.equal(expense.currency, 'NGN');
  assert.equal((await (await command(root, input, 'POST', key)).json()).id, expense.id);
  const id = `${root}/${expense.id}`;
  assert.equal((await command(id, { version: 1, reference: 'SR-001' }, 'PATCH')).status, 200);
  assert.equal((await command(`${id}/void`, { version: 1, reason: 'Incorrect entry' })).status, 409);
  assert.equal((await command(`${id}/void`, { version: 2, reason: '' })).status, 422);
  const voided = await command(`${id}/void`, { version: 2, reason: 'Incorrect entry' });
  assert.equal(voided.status, 200, await voided.clone().text());
  assert.equal((await voided.json()).status, 'VOID');
  assert.equal((await command(id, { version: 3, amountKobo: '2500000' }, 'PATCH')).status, 409);
});

test('manual settlement replay, concurrent receipts and reversal preserve outstanding balances', async () => {
  const owner = await signIn('owner');
  const workspace = await createWorkspace(owner.cookie, 'Settlements test');
  const root = `/workspaces/${workspace.id}`;
  const command = (path, body, key = randomUUID()) => request(path, { cookie: owner.cookie, key, body });
  const customer = await (await command(`${root}/customers`, { displayName: 'Lagos trading partner' })).json();
  const draft = await (await command(`${root}/invoices`, {
    customerId: customer.id, issueDate: '2026-10-01', dueDate: '2026-10-31',
    lines: [{ description: 'Service', quantity: 1, unitKobo: '8500000' }],
  })).json();
  const path = `${root}/invoices/${draft.id}`;
  assert.equal((await command(`${path}/issue`, { version: 1 })).status, 200);
  const receipt = (amountKobo, version, key) => command(`${path}/settlements`, {
    amountKobo, version, receiptDate: '2026-10-15', reference: 'RECEIPT-01',
  }, key);
  const detail = () => request(path, { cookie: owner.cookie }).then((response) => response.json());

  const key = randomUUID();
  const [first, replay] = await Promise.all([receipt('3500000', 2, key), receipt('3500000', 2, key)]);
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(replay.status, 201, await replay.clone().text());
  const recorded = await first.json();
  assert.equal((await replay.json()).id, recorded.id);
  const part = await detail();
  assert.equal(part.outstandingKobo, '5000000');
  assert.equal(part.status, 'PART_PAID');
  assert.equal(part.version, 3);
  const filtered = await request(`${root}/invoices?status=PART_PAID`, { cookie: owner.cookie });
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.json()).items.length, 1);
  assert.equal((await receipt('5000001', 3)).status, 422);
  assert.equal((await command(`${path}/void`, { version: 3, reason: 'Invalid void' })).status, 409);

  const race = await Promise.all([receipt('5000000', 3), receipt('5000000', 3)]);
  assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
  const paid = await detail();
  assert.equal(paid.status, 'PAID');
  assert.equal(paid.outstandingKobo, '0');
  assert.equal(paid.overdue, false);
  const history = await request(`${path}/settlements`, { cookie: owner.cookie });
  assert.equal((await history.json()).items.length, 2);

  const reason = { version: 1, reason: 'Receipt was assigned incorrectly' };
  const reverseKey = randomUUID();
  const reverse = await command(`${root}/settlements/${recorded.id}/reverse`, reason, reverseKey);
  assert.equal(reverse.status, 200, await reverse.clone().text());
  assert.equal((await command(`${root}/settlements/${recorded.id}/reverse`, reason, reverseKey)).status, 200);
  assert.equal((await command(`${root}/settlements/${recorded.id}/reverse`, reason)).status, 409);
  const restored = await detail();
  assert.equal(restored.status, 'PART_PAID');
  assert.equal(restored.outstandingKobo, '3500000');
  assert.equal(restored.version, 5);
});

test('statement accounts store masked identifiers and enforce workspace-scoped versions', async () => {
  const owner = await signIn('owner');
  const other = await signIn('second-owner');
  const workspace = await createWorkspace(owner.cookie, 'Statement accounts test');
  const root = `/workspaces/${workspace.id}/accounts`;
  const create = (body, key = randomUUID()) => request(root, { cookie: owner.cookie, body, key });
  assert.equal((await create({ label: 'Operating', lastFour: '12345678' })).status, 422);
  const key = randomUUID();
  const response = await create({ label: 'Operating', lastFour: '0034' }, key);
  assert.equal(response.status, 201, await response.clone().text());
  const account = await response.json();
  assert.equal(account.lastFour, '0034');
  assert.equal((await (await create({ label: 'Operating', lastFour: '0034' }, key)).json()).id, account.id);
  const path = `${root}/${account.id}`;
  assert.equal((await request(path, { cookie: other.cookie })).status, 404);
  const update = (version) => request(path, {
    method: 'PATCH', cookie: owner.cookie, key: randomUUID(), body: { version, label: 'Operating account' },
  });
  assert.equal((await update(1)).status, 200);
  assert.equal((await update(1)).status, 409);
  const listed = await request(`${root}?active=true`, { cookie: owner.cookie });
  assert.equal((await listed.json()).items[0].label, 'Operating account');
});

test('statement publication resolves ambiguous rows, replays exact files and revalidates stale previews', async (t) => {
  const storage = new ObjectStorage();
  let injectedFailures = 0;
  const jobs = startJobs(importHandlers({
    open(key) {
      if (injectedFailures++ === 0) throw new Error('Injected object-store interruption');
      return storage.open(key);
    },
  }));
  const db = new PrismaClient();
  try {
    const owner = await signIn('owner');
    const other = await signIn('second-owner');
    const workspace = await createWorkspace(owner.cookie, 'Statement imports test');
    const root = `/workspaces/${workspace.id}`;
    const command = (path, body, method = 'POST', key = randomUUID()) => request(path, { cookie: owner.cookie, body, method, key });
    const account = await (await command(`${root}/accounts`, { label: 'Operating' })).json();
    const header = 'date,description,amount,reference,source_id\n';
    const identical = '2026-10-02,Receipt,35000.01,Ref-A,\n';
    const stable = '2026-10-08,Expense,-25000,Ref-B,stable-001\n';
    const coverage = { coverageStart: '2026-10-01', coverageEnd: '2026-10-31' };
    const mapping = { date: 0, description: 1, dateFormat: 'ISO', money: { mode: 'signed', amount: 2 }, reference: 3, sourceId: 4 };

    const uploaded = async (text) => {
      const file = Buffer.from(text);
      const response = await command(`${root}/imports`, { accountId: account.id, filename: 'statement.csv', bytes: file.length });
      assert.equal(response.status, 201, await response.clone().text());
      const ticket = await response.json();
      const payload = await fetch(base + ticket.uploadUrl, {
        method: 'PUT', headers: { 'Content-Type': 'text/csv', 'X-Upload-Ticket': ticket.uploadTicket, Cookie: owner.cookie, Origin: origin }, body: file,
      });
      assert.equal(payload.status, 200, await payload.clone().text());
      return payload.json();
    };
    const load = async (id) => (await request(`${root}/imports/${id}`, { cookie: owner.cookie })).json();
    const wait = async (id, state) => {
      const end = Date.now() + 12_000;
      while (Date.now() < end) {
        const batch = await load(id);
        if (batch.state === state) return batch;
        if (batch.state === 'FAILED') assert.fail(JSON.stringify(batch));
        await new Promise((resolve) => setTimeout(resolve, 70));
      }
      assert.fail(`Expected ${state}: ${JSON.stringify(await load(id))}`);
    };
    const validate = (batch, override = mapping) => command(`${root}/imports/${batch.id}/validate`, { ...coverage, mapping: override, version: batch.version });
    const commit = (batch, key) => command(`${root}/imports/${batch.id}/commit`, { version: batch.version }, 'POST', key);
    const rows = async (id) => (await (await request(`${root}/imports/${id}/rows`, { cookie: owner.cookie })).json()).items;
    const countEntries = () => db.$transaction(async (tx) => {
      await setContext(tx, owner.actor.id, workspace.id);
      return tx.statementEntry.count();
    });
    const resolve = async (batch, decision) => {
      const choices = (await rows(batch.id)).filter((row) => row.ambiguous && !row.error).map((row) => ({ rowId: row.id, decision }));
      const response = await command(`${root}/imports/${batch.id}/resolutions`, { version: batch.version, choices }, 'PATCH');
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };

    const firstFile = header + identical + identical + stable;
    const upload = await uploaded(firstFile);
    const secondUpload = await uploaded(header + identical + '2026-10-09,Other credit,50000,Ref-C,\n');
    assert.equal((await request(`${root}/imports/${upload.id}`, { cookie: other.cookie })).status, 404);
    const queued = await validate(upload);
    assert.equal(queued.status, 202, await queued.clone().text());
    assert.ok(queued.headers.get('location').endsWith(upload.id));
    assert.equal((await validate(secondUpload)).status, 202);
    const firstReview = await wait(upload.id, 'REVIEW');
    const secondReview = await wait(secondUpload.id, 'REVIEW');
    assert.equal(firstReview.reviewCount, 2);
    assert.equal(secondReview.reviewCount, 0);
    assert.equal(await countEntries(), 0);
    assert.equal((await commit(firstReview)).status, 422);
    const accepted = await resolve(firstReview, 'KEEP');
    const commitKey = randomUUID();
    assert.equal((await commit(accepted, commitKey)).status, 202);
    assert.equal((await commit(accepted, commitKey)).status, 202);
    assert.equal((await wait(upload.id, 'COMMITTED')).acceptedCount, 3);
    assert.equal(await countEntries(), 3);
    assert.ok(injectedFailures >= 3);

    assert.equal((await commit(secondReview)).status, 202);
    const stale = await wait(secondReview.id, 'REVIEW');
    assert.equal(stale.problemCode, 'IMPORT_PREVIEW_STALE');
    assert.equal(stale.reviewCount, 1);
    assert.equal(await countEntries(), 3);
    assert.equal((await commit(await resolve(stale, 'DUPLICATE'))).status, 202);
    assert.equal((await wait(secondReview.id, 'COMMITTED')).acceptedCount, 1);
    assert.equal(await countEntries(), 4);

    const replay = await uploaded(firstFile);
    const existing = await validate(replay);
    assert.equal(existing.status, 202);
    assert.equal((await existing.json()).id, upload.id);
    assert.equal(await countEntries(), 4);

    const differentMapping = await uploaded(firstFile);
    assert.equal((await validate(differentMapping, { ...mapping, dateFormat: 'DMY' })).status, 409);

    const conflicting = await uploaded(header + '2026-10-08,Different,-25000,Ref-B,stable-001\n');
    assert.equal((await validate(conflicting)).status, 202);
    const invalid = await wait(conflicting.id, 'REVIEW');
    assert.equal(invalid.errorCount, 1);
    assert.match((await rows(invalid.id))[0].error, /source transaction ID/);
    assert.equal((await commit(invalid)).status, 422);

    const empty = await uploaded(header);
    assert.equal((await validate(empty)).status, 202);
    assert.equal((await commit(await wait(empty.id, 'REVIEW'))).status, 202);
    const emptyResult = await wait(empty.id, 'COMMITTED');
    assert.equal(emptyResult.acceptedCount, 0);
    assert.equal(emptyResult.coverageEnd, coverage.coverageEnd);
    await t.test('confirmed matches preserve manual receipt value and serialize competing confirmations', async () => {
      const get = (path) => request(path, { cookie: owner.cookie }).then((response) => response.json());
      const customer = await (await command(`${root}/customers`, { displayName: 'Reconciliation customer' })).json();
      const invoice = await (await command(`${root}/invoices`, {
        customerId: customer.id, issueDate: '2026-10-01', dueDate: '2026-10-31',
        lines: [{ description: 'Fixture invoice', quantity: 1, unitKobo: '8500001' }],
      })).json();
      const invoicePath = `${root}/invoices/${invoice.id}`;
      assert.equal((await command(`${invoicePath}/issue`, { version: 1 })).status, 200);
      const receipt = await (await command(`${invoicePath}/settlements`, {
        version: 2, amountKobo: '3500001', receiptDate: '2026-10-02', reference: 'ref-a',
      })).json();
      const expense = await (await command(`${root}/expenses`, {
        payee: 'Supplies', date: '2026-10-08', category: 'SUPPLIES', amountKobo: '2500000', reference: 'Ref-B',
      })).json();
      const { items } = await get(`${root}/statement-entries`);
      const credit = items.find((row) => row.amountKobo === '3500001');
      const remainder = items.find((row) => row.amountKobo === '5000000');
      const debit = items.find((row) => row.amountKobo === '-2500000');
      assert.ok(credit && remainder && debit);
      const suggest = (row) => get(`${root}/statement-entries/${row.id}/candidates`);
      const match = (entry, kind, target, version) => command(`${root}/matches`, {
        entryId: entry.id, targetKind: kind, targetId: target.id, targetVersion: version,
      });
      const [receiptCandidate] = await suggest(credit);
      assert.equal(receiptCandidate.id, receipt.id);
      assert.equal(receiptCandidate.signal, 'REFERENCE');
      assert.equal(receiptCandidate.resultingBalanceKobo, '5000000');
      const competing = await Promise.all([match(credit, 'SETTLEMENT', receipt, 1), match(credit, 'SETTLEMENT', receipt, 1)]);
      assert.deepEqual(competing.map((response) => response.status).sort(), [201, 409]);
      const receiptMatch = await competing.find((response) => response.status === 201).json();
      assert.equal((await get(invoicePath)).outstandingKobo, '5000000');
      assert.equal((await command(`${root}/settlements/${receipt.id}/reverse`, { version: 1, reason: 'Test' })).status, 409);

      const [invoiceCandidate] = await suggest(remainder);
      assert.equal(invoiceCandidate.kind, 'INVOICE');
      assert.equal(invoiceCandidate.resultingBalanceKobo, '0');
      const paid = await match(remainder, 'INVOICE', invoice, 3);
      assert.equal(paid.status, 201, await paid.clone().text());
      assert.equal((await get(invoicePath)).outstandingKobo, '0');

      const [expenseCandidate] = await suggest(debit);
      assert.equal(expenseCandidate.signal, 'REFERENCE');
      const matched = await match(debit, 'EXPENSE', expense, 1);
      assert.equal(matched.status, 201, await matched.clone().text());
      const expenseMatch = await matched.json();
      assert.equal((await command(`${root}/expenses/${expense.id}`, { version: 1, payee: 'Changed' }, 'PATCH')).status, 409);
      assert.equal((await command(`${root}/expenses/${expense.id}/void`, { version: 1, reason: 'Test' })).status, 409);

      const reverse = (id) => command(`${root}/matches/${id}/reverse`, { version: 1, reason: 'Corrected match' });
      assert.equal((await reverse((await paid.json()).id)).status, 200);
      assert.equal((await get(invoicePath)).outstandingKobo, '5000000');
      assert.equal((await reverse(receiptMatch.id)).status, 200);
      assert.equal((await get(invoicePath)).outstandingKobo, '5000000');
      const history = await get(`${invoicePath}/settlements`);
      assert.equal(history.items.find((row) => row.id === receipt.id).verified, false);
      assert.equal((await reverse(expenseMatch.id)).status, 200);
      assert.equal((await get(`${root}/statement-entries/${debit.id}`)).status, 'UNMATCHED');
    });
  } finally {
    await jobs.stop();
    storage.onModuleDestroy();
    await db.$disconnect();
  }
});
