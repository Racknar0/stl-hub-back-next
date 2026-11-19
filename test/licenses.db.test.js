// Prueba de activación simultánea contra MySQL real (la base local de DATABASE_URL).
// Crea un producto de prueba con su serial, lanza 20 activaciones a la vez y lo borra al terminar.
// Se omite si no hay conexión a la base.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createLicenseService } from '../src/services/licenses.service.js';
import { generateKeyPair, loadSigningKeys } from '../src/utils/licenseCrypto.js';

const prisma = new PrismaClient();
let dbAvailable = true;
try { await prisma.$connect(); await prisma.licenseProduct.count(); } catch { dbAvailable = false; }

test('MySQL: 20 simultaneous activations of one serial, exactly one wins; revoke and reset', { skip: !dbAvailable && 'sin base de datos' }, async () => {
  const keys = loadSigningKeys({ LICENSE_SIGNING_PRIVATE_KEY: generateKeyPair().privateKeyBase64 });
  const service = createLicenseService({ prisma, getKeys: () => keys });
  const product_id = `test-${crypto.randomBytes(4).toString('hex')}`;
  await service.createProduct({ product_id, name: 'Prueba concurrencia' });
  try {
    const { serials: [created] } = await service.createSerials({ product_id, count: 1 });
    const installs = Array.from({ length: 20 }, (_, i) => `install-${i}-${crypto.randomBytes(4).toString('hex')}`);
    const results = await Promise.allSettled(installs.map(installation_id => service.activate({ product_id, serial: created.serial, installation_id })));
    const winners = results.filter(r => r.status === 'fulfilled');
    assert.equal(winners.length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'already_activated'));
    const row = await service.getSerial(created.id);
    assert.equal(row.installation_id, winners[0].value.installation_id);

    // Idempotente desde la ganadora, también en paralelo
    const again = await Promise.all([1, 2, 3].map(() => service.activate({ product_id, serial: created.serial, installation_id: row.installation_id })));
    assert.ok(again.every(r => r.valid));

    await service.revokeSerial(created.id, { reason: 'prueba' });
    const v = await service.validate({ product_id, installation_id: row.installation_id, license: winners[0].value.license });
    assert.equal(v.reason, 'revoked');
    await assert.rejects(service.activate({ product_id, serial: created.serial, installation_id: row.installation_id }), { code: 'revoked' });

    await service.unrevokeSerial(created.id);
    await service.resetActivation(created.id);
    const other = await service.activate({ product_id, serial: created.serial, installation_id: installs.find(i => i !== row.installation_id) });
    assert.equal(other.valid, true);
  } finally {
    const product = await prisma.licenseProduct.findUnique({ where: { code: product_id } });
    await prisma.licenseSerial.deleteMany({ where: { productId: product.id } });
    await prisma.licenseProduct.delete({ where: { id: product.id } });
    await prisma.$disconnect();
  }
});
