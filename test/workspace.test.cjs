const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test, before, after } = require('node:test');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../dist/app');
const { setContext } = require('../dist/platform/transaction');

let app;
let base;
const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';

before(async () => {
  app = await createApp(true);
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

after(async () => {
  await app?.close();
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
