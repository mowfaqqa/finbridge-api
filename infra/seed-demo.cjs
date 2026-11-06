const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { signIn, poll, webOrigin } = require('./demo-client.cjs');
const { completedMonths } = require('../dist/reporting/reports');

const header = 'date,description,amount,reference,source_id\n';
const mapping = { date: 0, description: 1, dateFormat: 'ISO', money: { mode: 'signed', amount: 2 }, reference: 3, sourceId: 4 };

async function seed() {
  const owner = await signIn('owner');
  const call = owner.call;
  const period = completedMonths(new Date());
  const date = period.end.slice(0, 7) + '-15';
  const workspace = await call('/workspaces', { displayName: 'FinBridge synthetic SME', sector: 'Professional services' });
  const root = `/workspaces/${workspace.id}`;
  const customer = await call(`${root}/customers`, { displayName: 'Akin Demo Trading' });
  const draft = await call(`${root}/invoices`, {
    customerId: customer.id, issueDate: period.end.slice(0, 7) + '-01', dueDate: period.end,
    lines: [{ description: 'Monthly service engagement', quantity: 1, unitKobo: '8500000' }],
  });
  const issued = await call(`${root}/invoices/${draft.id}/issue`, { version: draft.version });
  const receipt = await call(`${root}/invoices/${draft.id}/settlements`, {
    version: issued.version, amountKobo: '3500000', receiptDate: date, reference: 'DEMO-RECEIPT',
  });
  const expense = await call(`${root}/expenses`, {
    date, payee: 'Demo Office Supplies', category: 'SUPPLIES', amountKobo: '2500000', reference: 'DEMO-EXPENSE',
  });
  const operating = await call(`${root}/accounts`, { label: 'Operating', lastFour: '0101' });
  const reserve = await call(`${root}/accounts`, { label: 'Reserve', lastFour: '0202' });

  const validationTimes = [];
  async function publish(accountId, filename, records, expectedId) {
    const file = Buffer.from(header + records.map((row) => [date, ...row].join(',')).join('\n') + '\n');
    const ticket = await call(`${root}/imports`, { accountId, filename, bytes: file.length });
    const staged = await owner.upload(ticket, file);
    const start = performance.now();
    const result = await call(`${root}/imports/${staged.id}/validate`, {
      version: staged.version, mapping, coverageStart: period.start, coverageEnd: period.end,
    });
    if (expectedId) {
      assert.equal(result.id, expectedId);
      return result.id;
    }
    const statusPath = `${root}/imports/${result.id}`;
    const review = await poll(() => call(statusPath), 'REVIEW');
    validationTimes.push(Math.round(performance.now() - start));
    assert.equal(review.errorCount + review.reviewCount, 0);
    await call(`${statusPath}/commit`, { version: review.version });
    await poll(() => call(statusPath), 'COMMITTED');
    return review.id;
  }

  const operatingRows = [
    ['Recorded receipt', '35000', 'DEMO-RECEIPT', 'demo-001'],
    ['Remaining invoice payment', '50000', issued.number, 'demo-002'],
    ['Supplies debit', '-25000', 'DEMO-EXPENSE', 'demo-003'],
    ['Transfer to reserve', '-20000', 'DEMO-TRANSFER', 'demo-004'],
  ];
  const operatingImport = await publish(operating.id, 'operating.csv', operatingRows);
  await publish(operating.id, 'operating.csv', operatingRows, operatingImport);
  await publish(reserve.id, 'reserve.csv', [['Transfer from operating', '20000', 'DEMO-TRANSFER', 'demo-005']]);

  const lines = (await call(`${root}/statement-entries`)).items;
  const entry = (description) => lines.find((item) => item.description === description).id;
  const confirm = (description, kind, record, targetVersion) => call(`${root}/matches`, {
    entryId: entry(description), targetKind: kind, targetId: record.id, targetVersion,
  });
  await confirm('Recorded receipt', 'SETTLEMENT', receipt, receipt.version);
  const outstanding = await call(`${root}/invoices/${draft.id}`);
  assert.equal(outstanding.outstandingKobo, '5000000');
  await confirm('Remaining invoice payment', 'INVOICE', issued, outstanding.version);
  await confirm('Supplies debit', 'EXPENSE', expense, expense.version);
  await call(`${root}/transfers`, {
    debitEntryId: entry('Transfer to reserve'), creditEntryId: entry('Transfer from operating'),
  });

  const flow = await call(`${root}/reports/cash-flow`);
  assert.deepEqual(flow.totals, { inflowKobo: '8500000', outflowKobo: '2500000', netKobo: '6000000' });
  assert.equal(flow.status, 'COMPLETE');
  assert.equal((await call(`${root}/reports/receivables`)).totalOpenKobo, '0');
  const started = performance.now();
  const job = await call(`${root}/evidence`, { confirmIncomplete: false });
  const pack = await poll(() => call(`${root}/evidence/${job.id}`), 'READY');
  const evidenceMs = Math.round(performance.now() - started);
  assert.equal(pack.incomplete, false);

  for (const [persona, role] of [['operator', 'OPERATOR'], ['viewer', 'VIEWER']]) {
    const invite = await call(`${root}/invitations`, { email: `${persona}@finbridge.test`, role });
    const member = await signIn(persona);
    await member.call('/invitations/accept', { token: invite.token });
  }

  const base = new URL(`/w/${workspace.slug}/`, webOrigin);
  console.log(JSON.stringify({
    workspaceSlug: workspace.slug, workspaceId: workspace.id, packId: job.id,
    overview: new URL('overview', base).href, readiness: new URL(`readiness?pack=${job.id}`, base).href,
    totalsKobo: flow.totals, openReceivablesKobo: '0', validationTimesMs: validationTimes, evidenceMs,
  }, null, 2));
}

seed().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
