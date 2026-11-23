import test from 'node:test';
import assert from 'node:assert/strict';
import { tumblrTags } from '../src/services/tumblr.service.js';

test('tumblrTags quita #, comas y duplicados y deja como mucho 20', () => {
  const tags = tumblrTags(['#3dprinting', '3dprinting', '#resin,print', ...Array.from({ length: 30 }, (_, i) => `#tag${i}`)]);
  assert.equal(tags[0], '3dprinting');
  assert.equal(tags[1], 'resin print');
  assert.equal(tags.length, 20);
  assert.ok(tags.every(t => !t.includes(',') && !t.startsWith('#')));
});

test('tumblrTags acepta valores vacíos', () => {
  assert.deepEqual(tumblrTags(null), []);
});
