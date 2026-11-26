import test from 'node:test';
import assert from 'node:assert/strict';
import { upcomingEvents, parseGoogleTrendsRss, buildTrendBrief } from '../src/services/trends.service.js';

test('upcomingEvents calcula Black Friday (día después del 4º jueves de noviembre)', () => {
  const events = upcomingEvents(new Date('2026-11-23T12:00:00Z'), 21);
  const bf = events.find(e => e.name === 'Black Friday');
  assert.equal(bf.date, '2026-11-27');
  assert.equal(bf.daysLeft, 4);
  assert.ok(events.some(e => e.name === 'Christmas' && e.daysLeft === 32) === false, 'Navidad queda fuera de 21 días');
  assert.deepEqual(events.map(e => e.daysLeft), [...events.map(e => e.daysLeft)].sort((a, b) => a - b));
});

test('upcomingEvents cruza el año (Año Nuevo desde diciembre)', () => {
  const events = upcomingEvents(new Date('2026-12-20T00:00:00Z'), 15);
  assert.ok(events.some(e => e.name === 'Christmas' && e.daysLeft === 5));
  assert.ok(events.some(e => e.name === 'New Year' && e.date === '2027-01-01'));
});

test('parseGoogleTrendsRss lee término y tráfico', () => {
  const xml = '<rss><channel><item><title>GTA VI release</title><ht:approx_traffic>500,000+</ht:approx_traffic></item><item><title><![CDATA[Dragon Ball &amp; Daima]]></title><ht:approx_traffic>20K+</ht:approx_traffic></item></channel></rss>';
  assert.deepEqual(parseGoogleTrendsRss(xml), [{ term: 'GTA VI release', score: 500000 }, { term: 'Dragon Ball & Daima', score: 20 }]);
});

test('buildTrendBrief: el puente solo como frase de enganche, nunca en títulos ni hashtags', () => {
  const brief = buildTrendBrief({
    related: ['DnD'], keywords: ['treasure chest 3d print'], seasonal: { event: 'Black Friday', daysLeft: 4, angle: 'gift idea' },
    bridge: { trend: 'GTA VI', hook: 'While we wait for GTA VI on PC, print this chest' }, hashtags: ['DnD', '3DPrinting'],
  });
  assert.match(brief, /DnD, treasure chest 3d print/);
  assert.match(brief, /Black Friday in 4 days/);
  assert.match(brief, /NEVER put it in the YouTube title, the hashtags or Pinterest/);
  assert.equal(buildTrendBrief(null), '');
});

test('missingFields: en modo automático sin textos no exige captions; en manual sí', async () => {
  const { missingFields } = await import('../src/services/reels.service.js');
  const base = { platforms: ['instagram', 'youtube'], status: 'PENDING', scheduledAt: new Date(Date.now() + 86400000), caption: null, title: null };
  assert.deepEqual(missingFields({ ...base, textMode: 'auto', autoTextsAt: null }), []);
  assert.ok(missingFields({ ...base, textMode: 'manual' }).length >= 2);
  // Automático ya generado para su hora: se valida normal
  assert.ok(missingFields({ ...base, textMode: 'auto', autoTextsAt: new Date(base.scheduledAt) }).length >= 2);
});

test('parseNewsRss quita el medio del final del titular', async () => {
  const { parseNewsRss } = await import('../src/services/trends.service.js');
  const xml = '<rss><item><title>Blizzard reveals WoW Forever event - IGN</title></item><item><title>World of Warcraft: what to know - Polygon</title></item></rss>';
  assert.deepEqual(parseNewsRss(xml), ['Blizzard reveals WoW Forever event', 'World of Warcraft: what to know']);
});

test('buildTrendBrief con tendencia caliente: va primero, hashtag y sin puente salvo en la versión permitida', async () => {
  const { hotHashtag } = await import('../src/services/trends.service.js');
  assert.equal(hotHashtag('WoW Forever'), 'WoWForever');
  assert.equal(hotHashtag('avengers: doomsday'), 'AvengersDoomsday');
  const angle = { hot: 'WoW Forever', related: ['World of Warcraft'], keywords: [], seasonal: null, bridge: { trend: 'Avengers Doomsday', hook: 'x' }, hashtags: [] };
  const main = buildTrendBrief(angle, { allowBridge: false });
  assert.match(main, /HOT TOPIC.*"WoW Forever"/);
  assert.match(main, /#WoWForever as the FIRST hashtag/);
  assert.match(main, /Do NOT mention "Avengers Doomsday"/);
  const alt = buildTrendBrief(angle, { allowBridge: true });
  assert.match(alt, /SECOND line of the caption only/);
});

test('deadAssetSearchLink: búsqueda con el nombre limpio del modelo', async () => {
  const { deadAssetSearchLink } = await import('../src/services/reels.service.js');
  assert.equal(
    deadAssetSearchLink({ assetTitle: 'STL - Goliath Gargoyles Disney', link: 'https://stlgratis.com/en/asset/stl---goliath-gargoyles-disney' }),
    'https://stlgratis.com/en/search?q=Goliath%20Gargoyles%20Disney',
  );
  assert.equal(deadAssetSearchLink({ assetTitle: '#37794 STL - Cammy White', link: 'https://stlgratis.com/es/asset/x', language: 'es' }), 'https://stlgratis.com/search?q=Cammy%20White');
});
