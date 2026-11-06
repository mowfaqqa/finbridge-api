const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { signIn } = require('./demo-client.cjs');

const sessions = 20;
const iterations = 20;

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 100) / 100;
}

async function benchmark() {
  const identities = await Promise.all(Array.from({ length: sessions }, () => signIn('owner')));
  const tenants = (await identities[0].call('/workspaces')).filter((workspace) => /^load-\d+$/.test(workspace.slug));
  assert.equal(tenants.length, 10, 'Seed the ten dedicated load fixtures first');
  const accountIds = await Promise.all(tenants.map(async ({ id }) =>
    (await identities[0].call(`/workspaces/${id}/accounts`)).items[0].id));
  const read = [];
  const write = [];
  await Promise.all(identities.map(async ({ call }, index) => {
    const tenant = index % tenants.length;
    const root = `/workspaces/${tenants[tenant].id}`;
    for (let i = 0; i < iterations; i++) {
      const startRead = performance.now();
      const page = await call(`${root}/statement-entries?limit=25&accountId=${accountIds[tenant]}`);
      read.push(performance.now() - startRead);
      assert.equal(page.items.length, 25);
      const startWrite = performance.now();
      await call(`${root}/expenses`, { date: '2026-10-15', payee: 'Synthetic load fixture', category: 'OTHER', amountKobo: '1250' });
      write.push(performance.now() - startWrite);
    }
  }));
  const result = { sessions, tenants: tenants.length, rowsPerTenant: 100_000, reads: read.length, writes: write.length, readP95Ms: p95(read), writeP95Ms: p95(write) };
  console.log(JSON.stringify(result, null, 2));
  if (result.readP95Ms > 400 || result.writeP95Ms > 700) process.exitCode = 1;
}

benchmark().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
