import test from 'node:test';
import assert from 'node:assert/strict';
import { mastodonText, normalizeInstance, MASTODON_MAX_TEXT } from '../src/services/mastodon.service.js';

test('normalizeInstance acepta dominio, URL o usuario completo', () => {
  assert.equal(normalizeInstance('mastodon.social'), 'https://mastodon.social');
  assert.equal(normalizeInstance('https://Mastodon.Social/@stlgratis'), 'https://mastodon.social');
  assert.equal(normalizeInstance('@stlgratis@mastodon.social'), 'https://mastodon.social');
  assert.equal(normalizeInstance(''), null);
});

test('mastodonText añade link y hasta 5 hashtags limpios sin pasar de 500', () => {
  const text = mastodonText('x'.repeat(800), 'https://stlgratis.com/v/abc', ['#3D printing', '#resin', '2024', '#minis', '#anime', '#cosplay', '#extra']);
  assert.ok([...text].length <= MASTODON_MAX_TEXT);
  assert.ok(text.includes('🔗 https://stlgratis.com/v/abc'));
  assert.ok(text.endsWith('#3Dprinting #resin #minis #anime #cosplay'));
  assert.ok(text.includes('…'));
});

test('mastodonText sin link ni tags deja el cuerpo tal cual', () => {
  assert.equal(mastodonText('Hola', null, []), 'Hola');
});
