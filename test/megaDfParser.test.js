import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStorageFromDfText } from '../src/utils/megaDfParser.js';

test('production over-quota output preserves the 20 GB capacity', () => {
  const metrics = parseStorageFromDfText(`Cloud drive: 20.02 GB in 180 file(s) and 208 folder(s)
Inbox: 0.00 B in 0 file(s) and 0 folder(s)
Rubbish bin: 0.00 B in 0 file(s) and 0 folder(s)
USED STORAGE: 20.02 GB 100.12% of 20.00 GB
Total size taken up by file versions: 0.00 B`);
  assert.equal(metrics.storageUsedMB, 20500);
  assert.equal(metrics.storageTotalMB, 20480);
  assert.ok(metrics.storageUsedMB / metrics.storageTotalMB > 1);
  assert.equal(metrics.fileCount, 180);
  assert.equal(metrics.folderCount, 208);
});

test('byte output retains excess after a quota reduction', () => {
  const metrics = parseStorageFromDfText('USED STORAGE: 32212254720 150.00% of 21474836480');
  assert.equal(metrics.storageUsedMB, 30720);
  assert.equal(metrics.storageTotalMB, 20480);
  assert.equal(metrics.storageUsedMB / metrics.storageTotalMB * 100, 150);
});

test('percentage fallback permits more than 100 percent', () => {
  const metrics = parseStorageFromDfText('Storage: 125% of 20 GB used');
  assert.equal(metrics.storageUsedMB, 25600);
  assert.equal(metrics.storageTotalMB, 20480);
});

test('zero usage keeps the reported quota', () => {
  const metrics = parseStorageFromDfText('USED STORAGE: 0 B 0.00% of 20 GB');
  assert.equal(metrics.storageUsedMB, 0);
  assert.equal(metrics.storageTotalMB, 20480);
});
