import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cooldownHours,
  isCoolingDown,
  orderGroups,
  recordFailure,
  clearFailure,
  pruneFailures,
} from '../src/utils/cronGroupQueue.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-11-16T12:00:00Z').getTime();
const group = (id, daysOld) => ({ m: { id }, oldestTs: now - daysOld * 24 * HOUR });

test('cooldownHours: crece con la racha y tiene tope', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(cooldownHours), [2, 4, 8, 16, 24, 24]);
});

test('isCoolingDown: solo dentro de la pausa', () => {
  assert.equal(isCoolingDown({ count: 1, at: new Date(now - 1 * HOUR).toISOString() }, now), true);
  assert.equal(isCoolingDown({ count: 1, at: new Date(now - 3 * HOUR).toISOString() }, now), false);
  assert.equal(isCoolingDown({ count: 2, at: new Date(now - 3 * HOUR).toISOString() }, now), true);
  assert.equal(isCoolingDown(undefined, now), false);
  assert.equal(isCoolingDown({ count: 1, at: 'x' }, now), false);
});

test('orderGroups: sin fallos, el más antiguo primero', () => {
  const out = orderGroups([group(1, 10), group(2, 40), group(3, 25)], {}, now);
  assert.deepEqual(out.map((g) => g.m.id), [2, 3, 1]);
});

test('orderGroups: el grupo que acaba de fallar pasa al final', () => {
  const failures = recordFailure({}, 2, now - HOUR, 'NO_PROXY');
  const out = orderGroups([group(1, 10), group(2, 40), group(3, 25)], failures, now);
  assert.deepEqual(out.map((g) => g.m.id), [3, 1, 2]);
});

test('orderGroups: pasada la pausa vuelve a su sitio', () => {
  const failures = recordFailure({}, 2, now - 3 * HOUR);
  const out = orderGroups([group(1, 10), group(2, 40)], failures, now);
  assert.deepEqual(out.map((g) => g.m.id), [2, 1]);
});

test('orderGroups: si todos están en pausa se intenta igual con el más antiguo', () => {
  let failures = recordFailure({}, 1, now);
  failures = recordFailure(failures, 2, now);
  const out = orderGroups([group(1, 10), group(2, 40)], failures, now);
  assert.deepEqual(out.map((g) => g.m.id), [2, 1]);
});

test('recordFailure / clearFailure: llevan la racha', () => {
  let f = recordFailure({}, 7, now, 'uno');
  f = recordFailure(f, 7, now + HOUR, 'dos');
  assert.equal(f[7].count, 2);
  assert.equal(f[7].error, 'dos');
  f = clearFailure(f, 7);
  assert.deepEqual(f, {});
  assert.deepEqual(clearFailure(f, 99), {});
});

test('pruneFailures: olvida grupos que ya no existen', () => {
  const f = { 1: { count: 1, at: 'a' }, 2: { count: 1, at: 'b' } };
  assert.deepEqual(Object.keys(pruneFailures(f, [2, 3])), ['2']);
});
