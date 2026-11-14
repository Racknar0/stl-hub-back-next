import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRegistrationSource, createRegistrationTimeseriesHandler } from '../src/controllers/registrationMetrics.controller.js';

const previousTimezone = process.env.TZ;
process.env.TZ = 'UTC'; // Production's existing range parsing; buckets are Bogotá.
after(() => { if (previousTimezone === undefined) delete process.env.TZ; else process.env.TZ = previousTimezone; });
const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
function mockDatabase(rows = []) {
  const calls = [];
  return { calls, $queryRawUnsafe: async (...args) => { calls.push(args); return rows; } };
}
function assertTotals(body) {
  assert.equal(body.total, body.series.reduce((sum, row) => sum + row.count, 0));
  assert.equal(body.total, body.sourceTotals.reduce((sum, row) => sum + row.total, 0));
  assert.equal(body.total, body.sourceSeries.reduce((sum, row) => sum + row.total, 0));
  for (const row of body.sourceSeries) assert.equal(row.total, Object.values(row.channels).reduce((sum, count) => sum + count, 0));
}

test('explicit UTM attribution wins over referrer and click identifiers', () => {
  assert.equal(classifyRegistrationSource({ utmSource: 'Pinterest', utmReferrer: 'https://www.google.com/search', clickGclid: '123' }), 'pinterest');
  assert.equal(classifyRegistrationSource({ utmSource: 'ig_ads', clickFbclid: '123' }), 'instagram');
  assert.equal(classifyRegistrationSource({ utmSource: 'reddit', clickGclid: '123' }), 'other');
  assert.equal(classifyRegistrationSource({ utmSource: '(direct)', utmReferrer: 'https://facebook.com/' }), 'direct');
});

test('referrer domains use exact domain families and preserve unrecognized sources', () => {
  for (const [utmReferrer, expected] of [
    ['https://www.google.com.co/search?q=stl', 'google'], ['https://www.pinterest.es/pin/123', 'pinterest'],
    ['https://l.facebook.com/path', 'facebook'], ['https://l.instagram.com/', 'instagram'],
    ['https://www.bing.com/search', 'bing'], ['https://youtu.be/abc', 'youtube'],
    ['https://t.me/stl', 'telegram'], ['https://vm.tiktok.com/abc', 'tiktok'],
    ['https://example.com/?google.com', 'other'], ['https://notfacebook.com/', 'other'],
  ]) assert.equal(classifyRegistrationSource({ utmReferrer }), expected, utmReferrer);
});

test('missing historical attribution is never manufactured as direct traffic', () => {
  for (const row of [{}, { utmSource: null }, { utmSource: '', utmReferrer: '' }, { utmSource: '(not set)' }, { utmReferrer: 'https://stlgratis.com/signup' }]) {
    assert.equal(classifyRegistrationSource(row), 'unknown');
  }
  assert.equal(classifyRegistrationSource({ utmMedium: 'direct' }), 'direct');
  assert.equal(classifyRegistrationSource({ utmReferrer: 'direct' }), 'direct');
  assert.equal(classifyRegistrationSource({ utmMedium: '(none)' }), 'unknown');
});

test('click identifiers classify fallback attribution without exposing identifiers', () => {
  for (const [field, expected] of [['clickGclid', 'google'], ['clickFbclid', 'meta'], ['clickTtclid', 'tiktok'], ['clickMsclkid', 'bing']]) {
    assert.equal(classifyRegistrationSource({ [field]: 'example-click-id' }), expected);
    assert.equal(classifyRegistrationSource({ [`has${field[0].toUpperCase()}${field.slice(1)}`]: 1n }), expected);
  }
  assert.equal(classifyRegistrationSource({ clickGclid: ' ', clickFbclid: null }), 'unknown');
});

test('one aggregate supplies both legacy registrations and zero-filled daily source counts', async () => {
  const db = mockDatabase([
    { registrationHour: '2026-10-31 20:00:00', cnt: 1n, utmSource: null },
    { registrationHour: '2026-11-01 09:00:00', cnt: 2n, utmSource: 'google' },
    { registrationHour: '2026-11-03 11:00:00', cnt: 1n, utmReferrer: 'https://www.pinterest.com/' },
    { registrationHour: '2026-11-03 11:00:00', cnt: 3n, hasClickFbclid: 1 },
  ]);
  const res = response();
  await createRegistrationTimeseriesHandler(db)({ query: { from: '2026-11-01', to: '2026-11-03' } }, res);
  assert.equal(db.calls.length, 1);
  const [sql, from, to] = db.calls[0];
  assert.match(sql, /FROM user/); assert.match(sql, /DATE_SUB\(createdAt, INTERVAL 5 HOUR\)/);
  assert.equal(from.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(to.toISOString(), '2026-11-03T23:59:59.000Z');
  assert.equal(res.body.granularity, 'day'); assert.equal(res.body.timezone, 'America/Bogota');
  assert.deepEqual(res.body.series, [{ date: '2026-10-31', count: 1 }, { date: '2026-11-01', count: 2 }, { date: '2026-11-03', count: 4 }]);
  // Existing UTC server boundaries include a partial preceding Bogotá date.
  assert.deepEqual(res.body.sourceSeries.map(row => row.date), ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  assert.ok(Object.values(res.body.sourceSeries[2].channels).every(count => count === 0));
  assert.equal(res.body.sourceTotals.find(row => row.source === 'unknown').label, 'Sin identificar');
  assert.equal(res.body.sourceTotals.find(row => row.source === 'direct').total, 0);
  assert.equal(res.body.total, 7); assertTotals(res.body);
  assert.ok(!JSON.stringify(res.body).includes('hasClick'));
});

test('hour, week and month keep their legacy buckets while sources stay daily', async () => {
  for (const [query, row, granularity, bucket] of [
    [{ from: '2026-11-03', to: '2026-11-03' }, '2026-11-03 10:00:00', 'hour', '2026-11-03 10:00'],
    [{ from: '2026-11-03', to: '2026-11-29' }, '2026-11-08 10:00:00', 'week', '2026-11-02'],
    [{ from: '2026-03-12', to: '2026-11-03' }, '2026-05-04 10:00:00', 'month', '2026-05-01'],
  ]) {
    const db = mockDatabase([{ registrationHour: row, cnt: 2, utmSource: 'telegram' }]);
    const res = response(); await createRegistrationTimeseriesHandler(db)({ query }, res);
    assert.equal(res.body.granularity, granularity);
    assert.deepEqual(res.body.series, [{ date: bucket, count: 2 }]); assertTotals(res.body);
    assert.ok(res.body.sourceSeries.every(item => Object.keys(item.channels).length === 12));
  }
});

test('mocked current date preserves the existing default range and empty buckets', async () => {
  const db = mockDatabase(); const res = response();
  await createRegistrationTimeseriesHandler(db, { now: () => new Date('2026-11-14T12:00:00Z') })({ query: {} }, res);
  assert.equal(db.calls[0][1].toISOString(), '2026-10-12T00:00:00.000Z');
  assert.equal(db.calls[0][2].toISOString(), '2026-11-14T12:00:00.000Z');
  assert.equal(res.body.granularity, 'week'); assert.deepEqual(res.body.series, []);
  assert.ok(res.body.sourceSeries.every(row => row.total === 0)); assertTotals(res.body);
});

test('invalid dates and database errors return controlled responses', async t => {
  for (const query of [{ from: 'bad-date' }, { from: '2026-11-03', to: '2026-11-01' }]) {
    const db = mockDatabase(); const res = response();
    await createRegistrationTimeseriesHandler(db)({ query }, res);
    assert.equal(res.statusCode, 400); assert.equal(db.calls.length, 0);
  }
  t.mock.method(console, 'error', () => {});
  const res = response(); await createRegistrationTimeseriesHandler({ $queryRawUnsafe: async () => { throw new Error('offline'); } })({ query: {} }, res);
  assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: 'internal' });
});
