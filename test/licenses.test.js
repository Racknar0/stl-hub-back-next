import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { createLicenseService, LICENSE_DAYS } from '../src/services/licenses.service.js';
import {
  generateSerial, normalizeSerial, hashSerial, maskSerial,
  generateKeyPair, loadSigningKeys, signLicense, verifyLicense,
} from '../src/utils/licenseCrypto.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

// Prisma en memoria. Las lecturas ceden el turno (como una consulta real) para que las
// activaciones simultáneas lean todas "libre" antes de escribir; el updateMany condicionado
// es lo único que decide quién gana, igual que el UPDATE ... WHERE en MySQL.
function fakePrisma() {
  const products = [];
  const serials = [];
  let seq = 1;
  const withProduct = (row, include) => row && (include?.product ? { ...row, product: products.find(p => p.id === row.productId) } : { ...row });
  const matches = (row, where) => Object.entries(where).every(([k, v]) => row[k] === v);
  return {
    licenseProduct: {
      findUnique: async ({ where }) => { await tick(); return products.find(p => matches(p, where)) || null; },
      create: async ({ data }) => { const p = { id: seq++, active: true, createdAt: new Date(), ...data }; products.push(p); return p; },
      update: async ({ where, data }) => { const p = products.find(x => x.id === where.id); Object.assign(p, data); return p; },
    },
    licenseSerial: {
      findUnique: async ({ where, include }) => { await tick(); return withProduct(serials.find(s => matches(s, where)) || null, include); },
      create: async ({ data }) => {
        const row = { id: seq++, installationId: null, activatedAt: null, lastValidatedAt: null, resetCount: 0, revokedAt: null, revokeReason: null, note: null, createdAt: new Date(), ...data };
        serials.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }) => {
        const hit = serials.filter(s => matches(s, where));
        hit.forEach(s => Object.assign(s, data));
        return { count: hit.length };
      },
      update: async ({ where, data, include }) => {
        const row = serials.find(s => s.id === where.id);
        for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + v.increment : v;
        return withProduct(row, include);
      },
    },
    _serials: serials,
  };
}

function setup() {
  const pair = generateKeyPair();
  const keys = loadSigningKeys({ LICENSE_SIGNING_PRIVATE_KEY: pair.privateKeyBase64, LICENSE_SIGNING_KEY_ID: 'test' });
  let clock = new Date('2026-11-19T00:00:00Z');
  const prisma = fakePrisma();
  const service = createLicenseService({ prisma, now: () => clock, getKeys: () => keys });
  return { prisma, service, keys, advanceDays: d => { clock = new Date(clock.getTime() + d * 86400000); } };
}

async function withSerial(f, product_id = 'pondwatch-update') {
  await f.service.createProduct({ product_id, name: 'PondWatch Update' }).catch(() => {});
  const { serials } = await f.service.createSerials({ product_id, count: 1 });
  return serials[0];
}

const INST_A = '3f1c9a52-6b0e-4d7f-9a21-8c4e2b7d5f10';
const INST_B = 'b7d5f103-6b0e-4d7f-9a21-3f1c9a528c4e';

test('serial: 25 Crockford chars in 5 groups, normalization and hash-only storage', async () => {
  const s = generateSerial();
  assert.match(s, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  assert.equal(normalizeSerial(s.toLowerCase().replace(/-/g, ' ')), s.replace(/-/g, ''));
  assert.equal(normalizeSerial('OIL00-00000-00000-00000-00000'), '0110000000000000000000000');
  assert.equal(normalizeSerial('short'), null);
  assert.equal(normalizeSerial('UUUUU-00000-00000-00000-00000'), null);

  const f = setup();
  const created = await withSerial(f);
  const stored = f.prisma._serials[0];
  assert.equal(stored.serialHash, hashSerial(normalizeSerial(created.serial)));
  assert.equal(stored.masked, maskSerial(normalizeSerial(created.serial)));
  assert.ok(!JSON.stringify(stored).includes(created.serial.replace(/-/g, '').slice(0, 10)));
});

test('activate returns a signed 30-day license; same installation is idempotent', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const first = await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  assert.equal(first.valid, true);
  const payload = verifyLicense(first.license, f.keys);
  assert.equal(payload.pid, 'pondwatch-update');
  assert.equal(payload.iid, INST_A);
  assert.equal(payload.exp - payload.iat, LICENSE_DAYS * 86400);
  assert.equal(first.expires_at, new Date(payload.exp * 1000).toISOString());

  f.advanceDays(2);
  const again = await f.service.activate({ product_id: 'pondwatch-update', serial: serial.toLowerCase(), installation_id: INST_A });
  assert.equal(again.valid, true);
  assert.equal(again.activated_at, first.activated_at);
});

test('activation from another installation is rejected', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_B }), { status: 409, code: 'already_activated' });
});

test('simultaneous activations from different installations: exactly one wins', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const installs = Array.from({ length: 20 }, (_, i) => `install-${String(i).padStart(4, '0')}`);
  const results = await Promise.allSettled(installs.map(installation_id => f.service.activate({ product_id: 'pondwatch-update', serial, installation_id })));
  const ok = results.filter(r => r.status === 'fulfilled');
  assert.equal(ok.length, 1);
  assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'already_activated'));
  assert.equal(f.prisma._serials[0].installationId, ok[0].value.installation_id);
});

test('unknown serial, other product and unknown product all return the same error', async () => {
  const f = setup();
  const { serial } = await withSerial(f, 'pondwatch-update');
  await f.service.createProduct({ product_id: 'other-app', name: 'Other' });
  const expected = { status: 404, code: 'invalid_serial', message: 'Serial no válido para este producto' };
  await assert.rejects(f.service.activate({ product_id: 'other-app', serial, installation_id: INST_A }), expected);
  await assert.rejects(f.service.activate({ product_id: 'no-such-app', serial, installation_id: INST_A }), expected);
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial: generateSerial(), installation_id: INST_A }), expected);
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial: 'garbage', installation_id: INST_A }), expected);
});

test('bad input is a 400', async () => {
  const f = setup();
  await assert.rejects(f.service.activate({ product_id: 'Bad Id', serial: 'x', installation_id: INST_A }), { status: 400 });
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial: 'x', installation_id: 'short' }), { status: 400 });
  await assert.rejects(f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A }), { status: 400 });
});

test('validate renews a valid license, also after it expired offline', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const act = await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  f.advanceDays(10);
  const v = await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license });
  assert.equal(v.valid, true);
  assert.ok(new Date(v.expires_at) > new Date(act.expires_at));
  f.advanceDays(45); // offline más de 30 días
  const late = await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: v.license });
  assert.equal(late.valid, true);
});

test('revocation: validate reports revoked and activation is refused; unrevoke restores it', async () => {
  const f = setup();
  const created = await withSerial(f);
  const act = await f.service.activate({ product_id: 'pondwatch-update', serial: created.serial, installation_id: INST_A });
  const revoked = await f.service.revokeSerial(created.id, { reason: 'reembolso' });
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license }),
    { valid: false, reason: 'revoked', message: 'La licencia fue revocada' });
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial: created.serial, installation_id: INST_A }), { status: 403, code: 'revoked' });
  await f.service.unrevokeSerial(created.id);
  assert.equal((await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license })).valid, true);
});

test('reset activation frees the serial for another installation and invalidates the old one', async () => {
  const f = setup();
  const created = await withSerial(f);
  const act = await f.service.activate({ product_id: 'pondwatch-update', serial: created.serial, installation_id: INST_A });
  const reset = await f.service.resetActivation(created.id);
  assert.equal(reset.status, 'unused');
  assert.equal(reset.reset_count, 1);
  assert.equal((await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license })).reason, 'activation_released');
  const b = await f.service.activate({ product_id: 'pondwatch-update', serial: created.serial, installation_id: INST_B });
  assert.equal(b.valid, true);
  assert.equal((await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license })).reason, 'installation_mismatch');
});

test('validate rejects tampered, foreign-key, other-product and other-installation licenses', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const act = await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  const [h, p, s] = act.license.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url'));
  forged.iid = INST_B;
  const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
  const v = (license, installation_id = INST_A, product_id = 'pondwatch-update') => f.service.validate({ product_id, installation_id, license });

  assert.equal((await v(tampered, INST_B)).reason, 'invalid_license');
  const otherKeys = loadSigningKeys({ LICENSE_SIGNING_PRIVATE_KEY: generateKeyPair().privateKeyBase64 });
  assert.equal((await v(signLicense(JSON.parse(Buffer.from(p, 'base64url')), otherKeys))).reason, 'invalid_license');
  assert.equal((await v('not.a.jwt')).reason, 'invalid_license');
  assert.equal((await v(act.license, INST_A, 'other-app')).reason, 'product_mismatch');
  assert.equal((await v(act.license, INST_B)).reason, 'installation_mismatch');
});

test('disabled product: activation looks like an invalid serial, validation says product_disabled', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const act = await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  const product = await f.prisma.licenseProduct.findUnique({ where: { code: 'pondwatch-update' } });
  await f.prisma.licenseProduct.update({ where: { id: product.id }, data: { active: false } });
  assert.equal((await f.service.validate({ product_id: 'pondwatch-update', installation_id: INST_A, license: act.license })).reason, 'product_disabled');
  await assert.rejects(f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A }), { code: 'invalid_serial' });
});

test('missing signing key gives 503 licensing_unavailable', async () => {
  const service = createLicenseService({ prisma: fakePrisma(), getKeys: () => null });
  await assert.rejects(service.activate({ product_id: 'pondwatch-update', serial: generateSerial(), installation_id: INST_A }), { status: 503, code: 'licensing_unavailable' });
});

test('license is a standard EdDSA JWT verifiable with the raw public key', async () => {
  const f = setup();
  const { serial } = await withSerial(f);
  const { license } = await f.service.activate({ product_id: 'pondwatch-update', serial, installation_id: INST_A });
  const [h, p, s] = license.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'EdDSA', typ: 'JWT', kid: 'test' });
  // Reconstruye la clave desde los 32 bytes crudos, como haría un cliente
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  const pub = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(f.keys.publicKeyRawBase64, 'base64')]), format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url')));
});
