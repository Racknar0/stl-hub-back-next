import test from 'node:test';
import assert from 'node:assert/strict';
import { createFreebieRollTimeseriesHandler } from '../src/controllers/freebieMetrics.controller.js';

const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('daily totals include zero days and distinct daily participants', async () => {
  let query;
  const handler = createFreebieRollTimeseriesHandler({ userDailyRolls: { groupBy: async args => {
    query = args;
    return [{ date: '2026-11-01', _sum: { rollsUsed: 9 }, _count: { _all: 3 } }, { date: '2026-11-03', _sum: { rollsUsed: 1 }, _count: { _all: 1 } }];
  } } });
  const res = response();
  await handler({ query: { from: '2026-11-01', to: '2026-11-03' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.series, [{ date: '2026-11-01', rolls: 9, participants: 3 }, { date: '2026-11-02', rolls: 0, participants: 0 }, { date: '2026-11-03', rolls: 1, participants: 1 }]);
  assert.deepEqual(query.where, { date: { gte: '2026-11-01', lte: '2026-11-03' }, rollsUsed: { gt: 0 } });
  assert.equal(res.body.timezone, 'UTC');
});

test('invalid dates and ranges never reach the database', async () => {
  const handler = createFreebieRollTimeseriesHandler({ userDailyRolls: { groupBy: () => assert.fail('unexpected database query') } });
  for (const query of [
    { from: '2026-02-30', to: '2026-03-01' },
    { from: 'invalid', to: '2026-03-01' },
    { from: '2026-11-02', to: '2026-11-01' },
    { from: '2000-01-01', to: '2026-11-01' },
  ]) {
    const res = response(); await handler({ query }, res); assert.equal(res.statusCode, 400);
  }
});

test('default range is exactly fifteen UTC dates, including today', async () => {
  const handler = createFreebieRollTimeseriesHandler({ userDailyRolls: { groupBy: async () => [] } });
  const res = response(); await handler({ query: {} }, res);
  assert.equal(res.body.series.length, 15);
  assert.equal(res.body.to, new Date().toISOString().slice(0, 10));
  assert.ok(res.body.series.every(day => day.rolls === 0 && day.participants === 0));
});

test('leap days remain daily and do not shift timezone', async () => {
  const handler = createFreebieRollTimeseriesHandler({ userDailyRolls: { groupBy: async () => [] } });
  const res = response(); await handler({ query: { from: '2024-02-28', to: '2024-03-01' } }, res);
  assert.deepEqual(res.body.series.map(day => day.date), ['2024-02-28', '2024-02-29', '2024-03-01']);
});

test('database failures return a controlled server error', async t => {
  t.mock.method(console, 'error', () => {});
  const handler = createFreebieRollTimeseriesHandler({ userDailyRolls: { groupBy: async () => { throw new Error('offline'); } } });
  const res = response(); await handler({ query: {} }, res);
  assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: 'internal' });
});
