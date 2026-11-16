import test from 'node:test';
import assert from 'node:assert/strict';
import { batchAccountLimitMb, batchAccountFreeMb, batchUsableFreeMb } from '../src/utils/batchAccountCapacity.js';

const GB = 1024;

test('el tope es el 95 % del tamaño real, también en cuentas de 10 GB', () => {
  assert.equal(batchAccountLimitMb(20 * GB), 19 * GB);
  assert.equal(batchAccountLimitMb(10 * GB), 9.5 * GB);
  assert.equal(batchAccountLimitMb(0), 18 * GB);
});

test('el libre descuenta lo usado y lo ya comprometido, sin bajar de cero', () => {
  const account = { storageTotalMB: 10 * GB, storageUsedMB: 8 * GB };
  assert.equal(batchAccountFreeMb(account), 1.5 * GB);
  assert.equal(batchAccountFreeMb(account, 1 * GB), 0.5 * GB);
  assert.equal(batchAccountFreeMb(account, 5 * GB), 0);
  assert.equal(batchAccountFreeMb({ storageTotalMB: 20 * GB, storageUsedMB: 20.5 * GB }), 0);
});

test('el libre utilizable de una main lo limita su backup activo más lleno', () => {
  const main = { id: 1, storageTotalMB: 20 * GB, storageUsedMB: 0 };
  const backups = [
    { id: 2, status: 'CONNECTED', storageTotalMB: 20 * GB, storageUsedMB: 17 * GB },
    { id: 3, status: 'SUSPENDED', storageTotalMB: 20 * GB, storageUsedMB: 20 * GB },
  ];
  assert.equal(batchUsableFreeMb(main, backups), 2 * GB);
  assert.equal(batchUsableFreeMb(main, []), 19 * GB);
  assert.equal(batchUsableFreeMb(main, backups, id => (id === 2 ? 1 * GB : 0)), 1 * GB);
});
