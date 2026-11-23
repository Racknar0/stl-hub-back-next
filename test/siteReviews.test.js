import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewInput,
  parseAdminReviewUpdate,
  shouldPromptReview,
  REVIEW_MIN_DOWNLOADS,
} from '../src/services/siteReviews.service.js';

test('parseReviewInput valida estrellas y nombre', () => {
  assert.equal(parseReviewInput({ rating: 0, displayName: 'Ana' }).error, 'INVALID_RATING');
  assert.equal(parseReviewInput({ rating: 6, displayName: 'Ana' }).error, 'INVALID_RATING');
  assert.equal(parseReviewInput({ rating: 4.5, displayName: 'Ana' }).error, 'INVALID_RATING');
  assert.equal(parseReviewInput({ rating: 5, displayName: ' a ' }).error, 'INVALID_NAME');
});

test('parseReviewInput normaliza texto, consentimiento e idioma', () => {
  const { data } = parseReviewInput({ rating: '5', displayName: '  Laura   M. ', text: '  muy\n bien ', consent: 'true', language: 'fr' });
  assert.deepEqual(data, { rating: 5, displayName: 'Laura M.', text: 'muy bien', consent: false, language: 'es' });
  assert.equal(parseReviewInput({ rating: 3, displayName: 'Ana', text: '   ' }).data.text, null);
  assert.equal(parseReviewInput({ rating: 3, displayName: 'Ana', text: 'x'.repeat(900) }).data.text.length, 500);
});

test('parseAdminReviewUpdate', () => {
  assert.equal(parseAdminReviewUpdate({}).error, 'NOTHING_TO_UPDATE');
  assert.equal(parseAdminReviewUpdate({ status: 'NOPE' }).error, 'INVALID_STATUS');
  const approved = parseAdminReviewUpdate({ status: 'APPROVED', featured: true }).data;
  assert.equal(approved.status, 'APPROVED');
  assert.equal(approved.featured, true);
  assert.ok(approved.reviewedAt instanceof Date);
  assert.equal(parseAdminReviewUpdate({ status: 'PENDING' }).data.reviewedAt, null);
});

test('shouldPromptReview: solo tras las descargas mínimas y sin opinión previa', () => {
  assert.equal(shouldPromptReview({ downloads: REVIEW_MIN_DOWNLOADS - 1, hasReview: false }), false);
  assert.equal(shouldPromptReview({ downloads: REVIEW_MIN_DOWNLOADS, hasReview: false }), true);
  assert.equal(shouldPromptReview({ downloads: 40, hasReview: true }), false);
});

test('la última tirada de Freebies se desbloquea solo con opinión', async () => {
  const { rollNeedsReview } = await import('../src/services/siteReviews.service.js');
  assert.equal(rollNeedsReview({ rollsUsed: 0, maxRolls: 3, hasReview: false }), false);
  assert.equal(rollNeedsReview({ rollsUsed: 1, maxRolls: 3, hasReview: false }), false);
  assert.equal(rollNeedsReview({ rollsUsed: 2, maxRolls: 3, hasReview: false }), true);
  assert.equal(rollNeedsReview({ rollsUsed: 2, maxRolls: 3, hasReview: true }), false);
  assert.equal(rollNeedsReview({ rollsUsed: 3, maxRolls: 3, hasReview: false }), false);
  assert.equal(rollNeedsReview({ rollsUsed: 0, maxRolls: 1, hasReview: false }), false);
});
