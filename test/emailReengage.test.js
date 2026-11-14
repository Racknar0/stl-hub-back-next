import test from 'node:test';
import assert from 'node:assert/strict';
import { isReengageCandidate, pickBatch, shouldCloseReengage } from '../src/services/emailReengage.service.js';

const dormant = (userId, lastSignal, extra = {}) => ({
  userId,
  stage: 'DORMANT',
  isActive: true,
  isPremium: false,
  optedOutAt: null,
  reengagedAt: null,
  lastSignal,
  ...extra,
});

test('candidatos: solo dormidos activos, sin baja, no Premium y sin envío previo', () => {
  assert.equal(isReengageCandidate(dormant(1, null)), true);
  assert.equal(isReengageCandidate(dormant(1, null, { stage: 'ACTIVE' })), false);
  assert.equal(isReengageCandidate(dormant(1, null, { isActive: false })), false);
  assert.equal(isReengageCandidate(dormant(1, null, { isPremium: true })), false);
  assert.equal(isReengageCandidate(dormant(1, null, { optedOutAt: new Date() })), false);
  assert.equal(isReengageCandidate(dormant(1, null, { reengagedAt: new Date() })), false);
  assert.equal(isReengageCandidate(dormant(1, null), new Set([1])), false);
});

test('tanda: los más recientes primero, sin señal al final, recortada', () => {
  const snapshot = [
    dormant(1, null),
    dormant(2, '2026-01-10T00:00:00Z'),
    dormant(3, '2026-03-10T00:00:00Z'),
    dormant(4, '2026-02-10T00:00:00Z', { isPremium: true }),
  ];
  assert.deepEqual(pickBatch(snapshot, { batchSize: 10 }).map((c) => c.userId), [3, 2, 1]);
  assert.deepEqual(pickBatch(snapshot, { batchSize: 2 }).map((c) => c.userId), [3, 2]);
  assert.deepEqual(pickBatch(snapshot, { batchSize: 10, alreadyQueued: new Set([3]) }).map((c) => c.userId), [2, 1]);
});

test('cierre: solo si venció el plazo y sigue dormido', () => {
  const now = new Date('2026-11-30T00:00:00Z');
  const base = { reengagedAt: '2026-11-15T00:00:00Z', optedOutAt: null, stage: 'DORMANT' };
  assert.equal(shouldCloseReengage(base, now, 10), true);
  assert.equal(shouldCloseReengage({ ...base, reengagedAt: '2026-11-25T00:00:00Z' }, now, 10), false, 'aún en plazo');
  assert.equal(shouldCloseReengage({ ...base, stage: 'ACTIVE' }, now, 10), false, 'reaccionó');
  assert.equal(shouldCloseReengage({ ...base, optedOutAt: new Date() }, now, 10), false, 'ya salió');
  assert.equal(shouldCloseReengage({ ...base, reengagedAt: null }, now, 10), false, 'nunca recibió');
});
