const assert = require('node:assert/strict');
const { test } = require('node:test');
const { completedMonths, unionCoverage } = require('../dist/reporting/reports');

test('Lagos month boundaries and clipped coverage preserve exact inclusive dates', () => {
  assert.deepEqual(completedMonths(new Date('2024-02-29T23:00:00Z')), { start: '2023-12-01', end: '2024-02-29' });
  assert.deepEqual(completedMonths(new Date('2024-02-29T22:59:59Z')), { start: '2023-11-01', end: '2024-01-31' });
  assert.deepEqual(unionCoverage({ start: '2024-02-01', end: '2024-02-29' }, [
    { start: '2024-01-29', end: '2024-02-03' },
    { start: '2024-02-03', end: '2024-02-05' },
    { start: '2024-02-06', end: '2024-02-06' },
    { start: '2024-02-28', end: '2024-03-03' },
  ]), {
    coveredDays: 8, totalDays: 29,
    gaps: [{ start: '2024-02-07', end: '2024-02-27' }],
    coveredRanges: [{ start: '2024-02-01', end: '2024-02-06' }, { start: '2024-02-28', end: '2024-02-29' }],
  });
});
