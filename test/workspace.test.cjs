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
