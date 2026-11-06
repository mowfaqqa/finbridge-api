const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { signIn, poll } = require('./demo-client.cjs');
const { completedMonths } = require('../dist/reporting/reports');

async function benchmark() {
  const owner = await signIn('owner');
  const workspace = await owner.call('/workspaces', { displayName: 'Synthetic async benchmark' });
  const root = `/workspaces/${workspace.id}`;
  const account = await owner.call(`${root}/accounts`, { label: 'Synthetic benchmark' });
  const period = completedMonths(new Date());
  const mapping = { date: 0, description: 1, dateFormat: 'ISO', money: { mode: 'signed', amount: 2 }, sourceId: 3 };
  const validationMs = [];
  const evidenceMs = [];
  for (let run = 1; run <= 5; run++) {
    const file = Buffer.from('date,description,amount,source_id\n' +
      Array.from({ length: 10_000 }, (_, i) => `${period.start},Synthetic row ${i},1.01,load-${run}-${i}`).join('\n') + '\n');
    const ticket = await owner.call(`${root}/imports`, { accountId: account.id, filename: `synthetic-${run}.csv`, bytes: file.length });
    const staged = await owner.upload(ticket, file);
    const validateStarted = performance.now();
    await owner.call(`${root}/imports/${staged.id}/validate`, {
      mapping, version: staged.version, coverageStart: period.start, coverageEnd: period.end,
    });
    const review = await poll(() => owner.call(`${root}/imports/${staged.id}`), 'REVIEW');
    validationMs.push(Math.round(performance.now() - validateStarted));
    assert.equal(review.rowCount, 10_000);
    assert.equal(review.errorCount + review.reviewCount, 0);
    const packStarted = performance.now();
    const job = await owner.call(`${root}/evidence`, { confirmIncomplete: true });
    await poll(() => owner.call(`${root}/evidence/${job.id}`), 'READY');
    evidenceMs.push(Math.round(performance.now() - packStarted));
  }
  console.log(JSON.stringify({ runs: 5, rowsPerPreview: 10_000, validationMs, evidenceMs }, null, 2));
  if (Math.max(...validationMs) > 60_000 || Math.max(...evidenceMs) > 30_000) process.exitCode = 1;
}

benchmark().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
