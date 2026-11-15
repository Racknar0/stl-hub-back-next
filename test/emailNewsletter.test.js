import test from 'node:test';
import assert from 'node:assert/strict';

process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret';
const news = (await import('../src/services/emailNewsletter.service.js')).default;
const engine = (await import('../src/services/emailEngine.service.js')).default;

test('semana y día de envío se miden en hora de Colombia', () => {
  // martes 17 nov 2026, 10:00 en Bogotá
  const tue = new Date('2026-11-17T15:00:00Z');
  assert.equal(news.weekdayOf(tue), 2);
  assert.equal(news.isNewsletterDay(tue), true);
  assert.equal(news.weekKey(tue), '2026-11-16');
  // domingo 22, 21:00 en Bogotá (ya lunes 23 en UTC) sigue en la semana del 16
  assert.equal(news.weekKey(new Date('2026-11-23T02:00:00Z')), '2026-11-16');
  assert.equal(news.weekKey(new Date('2026-11-23T06:00:00Z')), '2026-11-23');
  assert.equal(news.isNewsletterDay(new Date('2026-11-18T15:00:00Z')), false);
});

test('miniatura si existe, imagen entera si no', () => {
  const images = ['images/dragon/1700_0.webp', 'images/dragon/1700_1.webp'];
  assert.equal(news.pickImagePath(images, () => true), 'images/dragon/thumbs/thumb_1.webp');
  assert.equal(news.pickImagePath(images, () => false), 'images/dragon/1700_0.webp');
  assert.equal(news.pickImagePath(JSON.stringify(['/uploads/images/x/a.webp']), () => false), 'images/x/a.webp');
  assert.equal(news.pickImagePath([], () => true), null);
  assert.equal(news.pickImagePath(null, () => true), null);
});

test('modelos: los más nuevos que no descargó, en su idioma y con enlaces', () => {
  const assets = [
    { id: 1, title: 'Dragón', titleEn: 'Dragon', slug: 'dragon', images: ['images/dragon/a.webp'] },
    { id: 2, title: 'Orco', titleEn: null, slug: 'orco', images: ['images/orco/a.webp'] },
    { id: 3, title: 'Sin foto', slug: 'sin-foto', images: [] },
    { id: 4, title: 'Mecha', titleEn: 'Mech', slug: 'mecha', images: ['images/mecha/a.webp'] },
  ];
  const base = { assets, publicUrl: 'https://stlgratis.com', thumbExists: () => true };

  const es = news.buildModels({ ...base, language: 'es', downloaded: new Set([2]) });
  assert.deepEqual(es.map((m) => m.title), ['Dragón', 'Mecha']);
  assert.equal(es[0].url, 'https://stlgratis.com/asset/dragon');
  assert.equal(es[0].image, 'https://stlgratis.com/uploads/images/dragon/thumbs/thumb_1.webp');

  const en = news.buildModels({ ...base, language: 'en', count: 2 });
  assert.deepEqual(en.map((m) => m.title), ['Dragon', 'Orco']);
  assert.equal(en[0].url, 'https://stlgratis.com/en/asset/dragon');
});

test('una novedad atrasada más de 3 días se descarta', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  assert.equal(news.newsletterSkip({ scheduledFor: new Date('2026-11-19T12:00:00Z'), now }), null);
  assert.equal(news.newsletterSkip({ scheduledFor: new Date('2026-11-16T11:00:00Z'), now }), 'vencida');
});

test('ajuste del panel: novedades se encienden solo con fecha de corte', () => {
  const current = engine.buildConfig({}, {});
  assert.equal(current.newsletterEnabled, false);
  const ok = { current, hasSecret: true };
  assert.ok(engine.parseEngineSettings({ newsletterEnabled: true }, ok).error);
  assert.ok(engine.parseEngineSettings({ newsletterEnabled: 'si' }, ok).error);
  const res = engine.parseEngineSettings({ newsletterEnabled: true, start: '2026-11-20T00:00:00Z' }, ok);
  assert.equal(res.values.EMAIL_NEWSLETTER_ENABLED, 'true');
  assert.equal(engine.buildConfig({}, { EMAIL_NEWSLETTER_ENABLED: 'true' }).newsletterEnabled, true);
});
