const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { parseStatement, readHeaders, validateColumns } = require('../dist/statements/csv');

test('CSV parser enforces selected dates, exact kobo and split polarity', async () => {
  const raw = 'date,description,debit,credit\n'
    + '02/10/2026,Receipt,,35000.01\n'
    + '03/10/2026,Expense,25000,0\n'
    + '31/02/2026,Impossible,1,\n'
    + '04/10/2026,Both sides,1,1\n'
    + '05/10/2026,Fractional kobo,,1.001\n'
    + '06/10/2026,Zero,,0\n'
    + '\n';
  const mapping = { date: 0, description: 1, dateFormat: 'DMY', money: { mode: 'split', debit: 2, credit: 3 } };
  const headers = readHeaders(Buffer.from(raw));
  assert.deepEqual(headers, ['date', 'description', 'debit', 'credit']);
  assert.equal(validateColumns(mapping, headers), true);
  assert.equal(validateColumns({ ...mapping, reference: 2 }, headers), false);
  const rows = await parseStatement(Readable.from([Buffer.from(raw)]), 'test-account', mapping, headers, '2026-10-01', '2026-10-31');
  assert.equal(rows.length, 6);
  assert.equal(rows[0].amountKobo, 3_500_001n);
  assert.equal(rows[1].amountKobo, -2_500_000n);
  assert.match(rows[2].error, /real date/);
  assert.deepEqual(rows.slice(3).map((row) => row.rowNumber), [5, 6, 7]);
  assert.ok(rows.slice(3).every((row) => /nonzero decimal/.test(row.error)));
});
