import test from 'node:test';
import assert from 'node:assert/strict';
import { assetSizeFilter } from '../src/utils/assetSizeFilter.js';

test('optional bounds retain the table size priority and include boundaries', () => {
  assert.equal(assetSizeFilter({}), null);
  const range = { gte: 1572864n, lte: 2097152n };
  assert.deepEqual(assetSizeFilter({ minSizeMB: '1.5', maxSizeMB: '2' }), { OR: [{ fileSizeB: range }, { fileSizeB: null, archiveSizeB: range }] });
  assert.deepEqual(assetSizeFilter({ minSizeMB: '0' }).OR[0].fileSizeB, { gte: 0n });
});

test('invalid or reversed sizes are rejected before a database query', () => {
  for (const query of [{ minSizeMB: '-1' }, { maxSizeMB: 'Infinity' }, { minSizeMB: 'x' }, { minSizeMB: '3', maxSizeMB: '2' }, { maxSizeMB: '1e20' }]) assert.throws(() => assetSizeFilter(query), RangeError);
});

test('fractional MB round inward to whole-byte inclusive bounds', () => {
  const filter = assetSizeFilter({ minSizeMB: String(1 / 1048576), maxSizeMB: String(2 / 1048576) });
  assert.deepEqual(filter.OR[0].fileSizeB, { gte: 1n, lte: 2n });
});
