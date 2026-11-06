const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, sign } = require('node:crypto');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../dist/app');

function token(privateKey, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'local-test' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
}

test('OIDC verifies state, PKCE, nonce, audience, issuer and ID token signature', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const forged = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'local-test', alg: 'RS256', use: 'sig' };
  const clientId = 'finbridge-tests';
  const clientSecret = 'finbridge-test-client';
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const expectedRedirect = `${origin}/api/v1/auth/oidc/callback`;
  let issuer;
  let challenge;
  let nonce;
  let exchanges = 0;
  const provider = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/.well-known/openid-configuration') {
      response.end(JSON.stringify({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    if (request.url === '/jwks') {
      response.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    if (request.url === '/token') {
      exchanges += 1;
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      const actualChallenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
      const credentials = Buffer.from((request.headers.authorization ?? '').replace(/^Basic /, ''), 'base64')
        .toString().split(':').map(decodeURIComponent);
      const valid = challenge === actualChallenge && form.get('redirect_uri') === expectedRedirect
        && credentials[0] === clientId && credentials[1] === clientSecret;
      if (!valid) {
        response.writeHead(400);
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      const code = form.get('code');
      const now = Math.floor(Date.now() / 1000);
      response.end(JSON.stringify({
        access_token: 'synthetic-access',
        token_type: 'Bearer',
        id_token: token(code === 'bad-signature' ? forged : privateKey, {
          iss: code === 'bad-issuer' ? 'https://wrong.example' : issuer,
          sub: 'oidc-synthetic-test-owner',
          aud: code === 'bad-audience' ? 'different-app' : clientId,
          iat: now,
          exp: now + 600,
          nonce: code === 'bad-nonce' ? 'mismatched-nonce' : nonce,
          email: 'Identity@finbridge.test',
          email_verified: true,
        }),
      }));
      return;
    }
    response.writeHead(404).end('{}');
  });

  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  issuer = `http://127.0.0.1:${provider.address().port}`;
  Object.assign(process.env, {
    NODE_ENV: 'test',
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: clientSecret,
    OIDC_FLOW_SECRET: 'test-only-long-and-random-oidc-flow-signing-secret',
  });
  const app = await createApp(true);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const start = await fetch(`${base}/api/v1/auth/oidc/start?returnTo=/invitations/accept`, { redirect: 'manual' });
    assert.equal(start.status, 303, await start.clone().text());
    const authorization = new URL(start.headers.get('location'));
    const state = authorization.searchParams.get('state');
    challenge = authorization.searchParams.get('code_challenge');
    nonce = authorization.searchParams.get('nonce');
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.get('redirect_uri'), expectedRedirect);
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const callback = (code, expected = state, flow = cookie) =>
      fetch(`${base}/api/v1/auth/oidc/callback?${new URLSearchParams({ code, state: expected })}`, {
        headers: { Cookie: flow }, redirect: 'manual',
      });

    for (const response of [await callback('success', 'bad-state'), await callback('success', state, cookie.slice(0, -4) + 'AAAA')]) {
      assert.equal(response.headers.get('location'), '/sign-in-error');
    }
    assert.equal(exchanges, 0);
    for (const code of ['bad-signature', 'bad-issuer', 'bad-audience', 'bad-nonce']) {
      const response = await callback(code);
      assert.equal(response.headers.get('location'), '/sign-in-error', code);
      assert.ok(!response.headers.getSetCookie().some((header) => header.startsWith('finbridge_session=')), code);
    }
    const success = await callback('success');
    assert.equal(success.headers.get('location'), '/invitations/accept');
    const session = success.headers.getSetCookie().find((header) => header.startsWith('finbridge_session='));
    assert.ok(session);
    const identity = await fetch(`${base}/api/v1/auth/session`, { headers: { Cookie: session.split(';')[0] } });
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).verifiedEmail, 'identity@finbridge.test');
  } finally {
    await app.close();
    provider.close();
    await once(provider, 'close');
  }
});
