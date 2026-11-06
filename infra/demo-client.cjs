const { randomUUID } = require('node:crypto');

const apiOrigin = new URL(process.env.FINBRIDGE_LOCAL_API_URL ?? 'http://127.0.0.1:4000');
const webOrigin = new URL(process.env.WEB_ORIGIN ?? 'http://localhost:3000');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

if (!loopback.has(apiOrigin.hostname) || !loopback.has(webOrigin.hostname)) {
  throw new Error('Synthetic fixture commands require local loopback services');
}

async function expectJson(response, path) {
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(`Request failed at ${path} with ${response.status} ${problem.code ?? ''}`.trim());
  }
  return response.json();
}

async function signIn(persona) {
  const response = await fetch(new URL('/api/v1/auth/local-session', apiOrigin), {
    method: 'POST', headers: { Origin: webOrigin.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona }),
  });
  await expectJson(response, 'local sign-in');
  const cookie = response.headers.get('set-cookie').split(';')[0];

  const call = async (path, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(new URL(`/api/v1${path}`, apiOrigin), {
      method, headers: {
        Cookie: cookie, Origin: webOrigin.origin,
        ...(body !== undefined && { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return expectJson(response, path);
  };

  async function upload(ticket, file) {
    const response = await fetch(new URL(ticket.uploadUrl, apiOrigin), {
      method: 'PUT', body: file, headers: {
        Cookie: cookie, Origin: webOrigin.origin, 'Content-Type': 'text/csv', 'X-Upload-Ticket': ticket.uploadTicket,
      },
    });
    return expectJson(response, 'fixture upload');
  }
  return { call, upload };
}

async function poll(load, desired) {
  const deadline = Date.now() + 65_000;
  for (let delay = 200; Date.now() < deadline; delay = Math.min(delay * 1.5, 2000)) {
    const result = await load();
    if (result.state === desired) return result;
    if (result.state === 'FAILED' || result.state === 'DISCARDED') {
      throw new Error(`Fixture operation ended in ${result.state} ${result.problemCode ?? ''}`.trim());
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Timed out waiting for ${desired}. Check that the worker, Redis and object storage are running.`);
}

module.exports = { signIn, poll, webOrigin };
