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
