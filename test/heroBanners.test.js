import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  HERO_SLOTS, HERO_MAX_FILE_BYTES, HERO_SETTING_PREFIX, HERO_COOKIE,
  normalizeHeroFiles, optimizeHeroImage, isCompleteHeroVariant,
  heroVariantFromCookie, chooseHeroVariant, createHeroBannersService,
} from '../src/services/heroBanners.service.js';
import { createHeroRenderHandler } from '../src/controllers/heroBanners.controller.js';

const fixtureRoot = path.resolve('test', '.hero-banner-fixtures');
await fs.mkdir(fixtureRoot, { recursive: true });
const desktop = await sharp({ create: { width: 1024, height: 384, channels: 3, background: '#472ca2' } }).png().toBuffer();
const mobile = await sharp({ create: { width: 600, height: 750, channels: 3, background: '#642f9b' } }).png().toBuffer();
const files = () => Object.fromEntries(HERO_SLOTS.map(slot => [slot, { buffer: slot.endsWith('Desktop') ? desktop : mobile, mimetype: 'image/png', originalname: `${slot}.png` }]));
const errorCode = code => error => error.code === code;

function fakePrisma() {
  const records = new Map();
  return { records, systemSetting: {
    findMany: async () => [...records.values()],
    findUnique: async ({ where }) => records.get(where.key) || null,
    create: async ({ data }) => { if (records.has(data.key)) throw new Error('duplicate key'); records.set(data.key, { ...data }); return data; },
    updateMany: async ({ where, data }) => {
      const row = records.get(where.key);
      if (!row || row.value !== where.value) return { count: 0 };
      records.set(where.key, { ...row, ...data }); return { count: 1 };
    },
  } };
}

async function context(t, extra = {}) {
  const uploadsRoot = await fs.mkdtemp(path.join(fixtureRoot, 'case-'));
  t.after(async () => {
    const target = path.resolve(uploadsRoot);
    if (path.dirname(target) !== fixtureRoot) throw new Error('Unsafe test cleanup path');
    await fs.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const prisma = fakePrisma();
  const service = createHeroBannersService({ prisma, uploadsRoot, publicCacheMs: 0, ...extra });
  return { prisma, service, uploadsRoot };
}

test('the four exact components are mandatory; duplicates and unexpected slots fail', () => {
  for (const missing of HERO_SLOTS) {
    const input = files(); delete input[missing];
    assert.throws(() => normalizeHeroFiles(input), error => error.code === 'MISSING_COMPONENTS' && error.fields.includes(missing));
  }
  assert.deepEqual(Object.keys(normalizeHeroFiles(files())), HERO_SLOTS);
  assert.throws(() => normalizeHeroFiles({ ...files(), esDesktop: [files().esDesktop, files().esDesktop] }), errorCode('DUPLICATE_COMPONENT'));
  assert.throws(() => normalizeHeroFiles({ ...files(), extra: files().esDesktop }), errorCode('UNKNOWN_COMPONENT'));
});

test('real Sharp decoding rejects corrupt content, SVG disguised as PNG and byte/pixel limits', async () => {
  await assert.rejects(optimizeHeroImage({ buffer: Buffer.from('not a PNG'), mimetype: 'image/png' }, 'esDesktop'), errorCode('INVALID_IMAGE'));
  await assert.rejects(optimizeHeroImage({ buffer: Buffer.from('<svg width="1024" height="384" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="384"/></svg>'), mimetype: 'image/png' }, 'esDesktop'), errorCode('UNSUPPORTED_IMAGE'));
  await assert.rejects(optimizeHeroImage({ buffer: Buffer.alloc(HERO_MAX_FILE_BYTES + 1) }, 'esDesktop'), errorCode('FILE_TOO_LARGE'));
  await assert.rejects(optimizeHeroImage({ buffer: desktop }, 'esDesktop', { maxInputPixels: 1000 }), errorCode('PIXEL_LIMIT'));
});

test('minimum resolution and desktop/mobile ratios are enforced independently', async () => {
  const small = await sharp({ create: { width: 32, height: 12, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const square = await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#ffffff' } }).png().toBuffer();
  await assert.rejects(optimizeHeroImage({ buffer: small }, 'esDesktop'), errorCode('IMAGE_TOO_SMALL'));
  await assert.rejects(optimizeHeroImage({ buffer: square }, 'esDesktop'), errorCode('INVALID_ASPECT_RATIO'));
  await assert.rejects(optimizeHeroImage({ buffer: square }, 'esMobile'), errorCode('INVALID_ASPECT_RATIO'));
  const converted = await optimizeHeroImage({ buffer: desktop, originalname: 'incorrect.jpg' }, 'esDesktop');
  assert.equal((await sharp(converted.buffer).metadata()).format, 'webp');
  assert.equal(converted.width, 1024);
  assert.equal(converted.height, 384);
});

test('a complete upload creates four hashed WebP files and a public-safe manifest', async t => {
  const { service, uploadsRoot } = await context(t);
  const { variant } = await service.create({ name: 'Casa', altEs: 'Maceta y objetos útiles', altEn: 'Planter and useful objects', active: 'true' }, files());
  assert.ok(isCompleteHeroVariant(variant));
  assert.equal(variant.active, true);
  assert.equal(variant.archived, false);
  for (const slot of HERO_SLOTS) {
    const image = variant.images[slot];
    assert.match(image.url, /-[a-f0-9]{24}\.webp$/);
    const filename = path.join(uploadsRoot, image.url.replace('/uploads/', ''));
    assert.equal((await fs.stat(filename)).size, image.bytes);
    assert.equal((await sharp(await fs.readFile(filename)).metadata()).format, 'webp');
  }
  const published = await service.listPublic();
  assert.equal(published.length, 1);
  assert.equal(published[0].altEs, 'Maceta y objetos útiles');
  assert.equal(published[0].seedKey, undefined);
  assert.equal(published[0].version, undefined);
  assert.equal(published[0].createdAt, undefined);
});

test('incomplete or corrupt uploads never register a variant or leave image directories', async t => {
  const { service, prisma, uploadsRoot } = await context(t);
  const incomplete = files(); delete incomplete.enMobile;
  await assert.rejects(service.create({ name: 'Incomplete' }, incomplete), errorCode('MISSING_COMPONENTS'));
  const corrupt = files(); corrupt.enMobile = { buffer: Buffer.from('broken') };
  await assert.rejects(service.create({ name: 'Corrupt' }, corrupt), errorCode('INVALID_IMAGE'));
  assert.equal(prisma.records.size, 0);
  assert.deepEqual(await fs.readdir(uploadsRoot), []);
});

test('database failure rolls back only the freshly created owned UUID directory', async t => {
  const { service, prisma, uploadsRoot } = await context(t);
  prisma.systemSetting.create = async () => { throw new Error('DB unavailable'); };
  await assert.rejects(service.create({ name: 'Rollback' }, files()), /DB unavailable/);
  assert.deepEqual(await fs.readdir(path.join(uploadsRoot, 'hero-banners')), []);
});

test('archive, deactivate and restore govern public availability without deleting images', async t => {
  const { service } = await context(t);
  const { variant } = await service.create({ name: 'Lifecycle' }, files());
  await service.archive(variant.id);
  assert.equal((await service.listPublic()).length, 0);
  assert.equal((await service.listAdmin())[0].archived, true);
  await service.update(variant.id, { archived: false, active: true });
  assert.equal((await service.listPublic()).length, 1);
  await service.update(variant.id, { active: false });
  assert.equal((await service.listPublic()).length, 0);
});

test('a tampered incomplete record cannot be activated or included in the public list', async t => {
  const { service, prisma } = await context(t);
  const { variant } = await service.create({ name: 'Damaged', active: false }, files());
  const key = `${HERO_SETTING_PREFIX}${variant.id}`;
  const row = prisma.records.get(key);
  const damaged = JSON.parse(row.value); delete damaged.images.enDesktop;
  prisma.records.set(key, { ...row, value: JSON.stringify(damaged) });
  await assert.rejects(service.update(variant.id, { active: true }), errorCode('INCOMPLETE_VARIANT'));
  assert.deepEqual(await service.listPublic(), []);
  damaged.active = true; prisma.records.set(key, { ...row, value: JSON.stringify(damaged) });
  assert.deepEqual(await service.listPublic(), []);
});

test('missing stored image prevents activation and is omitted even from an active manifest', async t => {
  const { service, uploadsRoot } = await context(t);
  const { variant } = await service.create({ name: 'Missing file' }, files());
  const ownedFile = path.resolve(uploadsRoot, variant.images.enMobile.url.replace('/uploads/', ''));
  assert.ok(ownedFile.startsWith(path.resolve(uploadsRoot) + path.sep));
  await fs.unlink(ownedFile);
  assert.deepEqual(await service.listPublic(), []);
  await assert.rejects(service.update(variant.id, { active: true }), errorCode('MISSING_STORED_IMAGE'));
});

test('seed imports are idempotent and preserve subsequent admin edits', async t => {
  const { service } = await context(t);
  const first = await service.create({ name: 'Initial name' }, files(), { seedKey: 'user-variant-01' });
  await service.update(first.variant.id, { name: 'Admin edited', active: false });
  const repeated = await service.create({ name: 'Old import name' }, files(), { seedKey: 'user-variant-01' });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.variant.id, first.variant.id);
  assert.equal(repeated.variant.name, 'Admin edited');
  assert.equal(repeated.variant.active, false);
  assert.equal((await service.listAdmin()).length, 1);
});

test('concurrent changes are not silently overwritten and invalid IDs cannot form paths', async t => {
  const { service, prisma } = await context(t);
  const { variant } = await service.create({ name: 'Conflict' }, files());
  prisma.systemSetting.updateMany = async () => ({ count: 0 });
  await assert.rejects(service.update(variant.id, { name: 'New name' }), errorCode('CONCURRENT_UPDATE'));
  for (const id of ['../uploads', '', 'not-a-uuid']) await assert.rejects(service.update(id, { active: true }), errorCode('INVALID_ID'));
});

function response() {
  return {
    headers: {}, cookies: [], statusCode: 200,
    set(name, value) { this.headers[name] = value; return this; }, vary(value) { this.headers.Vary = value; return this; },
    cookie(name, value, options) { this.cookies.push({ name, value, options }); return this; },
    status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; },
    redirect(code, location) { this.statusCode = code; this.location = location; return this; },
  };
}

test('each refresh selects a new design and sets its matching language/device image', async t => {
  const { service } = await context(t);
  for (const name of ['One', 'Two', 'Three']) await service.create({ name }, files());
  const variants = await service.listPublic();
  const seed = 'a'.repeat(32);
  const chosen = chooseHeroVariant(variants, seed);
  assert.equal(chooseHeroVariant([...variants].reverse(), seed).id, chosen.id);
  let generations = 0;
  let previousId = chosen.id;
  const handler = createHeroRenderHandler({ service, randomSeed: () => { generations++; return seed; }, production: true });
  const targets = [['es', 'desktop'], ['en', 'desktop'], ['es', 'mobile'], ['en', 'mobile']];
  // Even identical random draws cannot repeat the preceding design.
  for (let refresh = 0; refresh < 20; refresh++) {
    const [lang, device] = targets[refresh % targets.length];
    const res = response();
    await handler({ params: { lang, device }, headers: { cookie: `${HERO_COOKIE}=${previousId}` } }, res);
    const selected = variants.find(v => v.id === res.headers['X-Hero-Variant']);
    assert.equal(res.statusCode, 302);
    assert.ok(selected);
    assert.notEqual(selected.id, previousId);
    assert.equal(res.location, selected.images[`${lang}${device === 'desktop' ? 'Desktop' : 'Mobile'}`].url);
    assert.deepEqual(res.cookies, [{ name: HERO_COOKIE, value: selected.id, options: { httpOnly: true, sameSite: 'lax', secure: true, path: '/' } }]);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    assert.equal(res.headers.Vary, 'Cookie');
    previousId = selected.id;
  }
  assert.equal(generations, 20);
});

test('rotation includes every eligible design and handles one or no eligible alternatives', async t => {
  const { service } = await context(t);
  for (const name of ['One', 'Two', 'Three']) await service.create({ name }, files());
  const variants = await service.listPublic();
  const [first, second, third] = variants;
  const seed = 'b'.repeat(32);
  const seen = new Set();
  let previousId = null;
  for (let draw = 0; draw < 100; draw++) {
    const selected = chooseHeroVariant(variants, draw.toString(16).padStart(32, '0'), previousId);
    assert.notEqual(selected.id, previousId);
    seen.add(selected.id);
    previousId = selected.id;
  }
  assert.equal(seen.size, 3);
  assert.equal(chooseHeroVariant([first], seed, first.id).id, first.id);
  assert.equal(chooseHeroVariant([first], seed, second.id).id, first.id);
  assert.equal(chooseHeroVariant([first, { ...second, active: false }, { ...third, archived: true }], seed, first.id).id, first.id);
  assert.equal(chooseHeroVariant([{ ...first, images: {} }], seed), null);
  assert.equal(chooseHeroVariant([], seed), null);
  assert.throws(() => chooseHeroVariant(variants, '../invalid'), errorCode('INVALID_SEED'));
  const handler = createHeroRenderHandler({ service: { listPublic: async () => [first] }, randomSeed: () => seed });
  for (const cookie of [undefined, `${HERO_COOKIE}=../../bad`, `${HERO_COOKIE}=${first.id}`, 'stl_hero_seed=' + 'a'.repeat(32)]) {
    const res = response();
    await handler({ params: { lang: 'es', device: 'desktop' }, headers: { cookie } }, res);
    assert.equal(res.headers['X-Hero-Variant'], first.id);
    assert.equal(res.cookies[0].value, first.id);
    assert.equal(res.location, first.images.esDesktop.url);
  }
});

test('cookie parsing validates IDs and an absent catalog falls back without recording a design', async () => {
  const handler = createHeroRenderHandler({ service: { listPublic: async () => [] }, randomSeed: () => 'b'.repeat(32), production: true });
  const res = response();
  await handler({ params: { lang: 'en', device: 'mobile' }, headers: { cookie: `${HERO_COOKIE}=../../bad` } }, res);
  assert.equal(res.location, '/hero/hero-mobile-en.png');
  assert.equal(res.headers['X-Hero-Variant'], 'fallback');
  assert.equal(res.cookies.length, 0);
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.equal(heroVariantFromCookie('unrelated=123'), null);
  assert.equal(heroVariantFromCookie(`${HERO_COOKIE}=../../bad`), null);
  assert.equal(heroVariantFromCookie(`${HERO_COOKIE}=${'a'.repeat(32)}`), null);
  assert.equal(heroVariantFromCookie(`${HERO_COOKIE}=${id}; foo=bar`), id);
});

test('render rejects invalid target before touching service and DB errors return fallback', async () => {
  const handler = createHeroRenderHandler({ service: { listPublic: async () => assert.fail('invalid target must not query') } });
  for (const params of [{ lang: 'fr', device: 'desktop' }, { lang: 'es', device: '../mobile' }]) {
    const res = response(); await handler({ params, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.cookies.length, 0);
  }
  const fallback = response();
  await createHeroRenderHandler({ service: { listPublic: async () => { throw new Error('DB offline'); } } })({ params: { lang: 'es', device: 'desktop' }, headers: {} }, fallback);
  assert.equal(fallback.statusCode, 302);
  assert.equal(fallback.location, '/hero/hero-desktop-es.png');
  assert.equal(fallback.cookies.length, 0);
});
