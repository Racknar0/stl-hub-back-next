import test from 'node:test';
import assert from 'node:assert/strict';
import { blueskyText, buildFacets, BLUESKY_MAX_TEXT } from '../src/services/bluesky.service.js';

const count = (t) => [...new Intl.Segmenter('es', { granularity: 'grapheme' }).segment(t)].length;

test('blueskyText añade el link al final y respeta 300 grafemas', () => {
  const link = 'https://stlgratis.com/s/abc123';
  const text = blueskyText('🏴‍☠️ '.repeat(400), link);
  assert.ok(count(text) <= BLUESKY_MAX_TEXT);
  assert.ok(text.endsWith(`🔗 ${link}`));
  assert.ok(text.includes('…'));
});

test('blueskyText deja el texto corto intacto', () => {
  assert.equal(blueskyText('Hola mundo', null), 'Hola mundo');
});

test('buildFacets marca el link con posiciones en bytes UTF-8', () => {
  const text = 'Pirata 🏴‍☠️ gratis\n\n🔗 https://stlgratis.com/s/abc.';
  const [f] = buildFacets(text);
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(bytes.subarray(f.index.byteStart, f.index.byteEnd).toString('utf8'), 'https://stlgratis.com/s/abc');
  assert.equal(f.features[0].uri, 'https://stlgratis.com/s/abc');
});

test('buildFacets marca hashtags y omite los numéricos', () => {
  const text = 'Figura #impresión3d lista #2024';
  const facets = buildFacets(text);
  assert.equal(facets.length, 1);
  const bytes = Buffer.from(text, 'utf8');
  assert.equal(bytes.subarray(facets[0].index.byteStart, facets[0].index.byteEnd).toString('utf8'), '#impresión3d');
  assert.equal(facets[0].features[0].tag, 'impresión3d');
});
