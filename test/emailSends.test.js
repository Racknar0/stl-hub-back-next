import test from 'node:test';
import assert from 'node:assert/strict';

const sends = (await import('../src/services/emailSends.service.js')).default;

test('filtros del historial: estado, tipo y búsqueda', () => {
  assert.deepEqual(sends.buildSendsWhere({}), {});
  assert.equal(sends.buildSendsWhere({ status: 'FAILED' }).status, 'FAILED');
  assert.equal(sends.buildSendsWhere({ status: 'cualquiera' }).status, undefined);
  assert.equal(sends.buildSendsWhere({ kind: 'NEWSLETTER' }).kind, 'NEWSLETTER');
  assert.equal(sends.buildSendsWhere({ kind: 'inventado' }).kind, undefined);
  assert.deepEqual(sends.buildSendsWhere({ kind: 'CAMPAIGN' }).dedupeKey, { startsWith: 'CAMPAIGN:' });
  assert.deepEqual(sends.buildSendsWhere({ q: '  ana@x.com ' }).contact, { user: { email: { contains: 'ana@x.com' } } });
});

test('una campaña concreta filtra por su clave y limpia caracteres raros', () => {
  assert.deepEqual(sends.buildSendsWhere({ campaign: 'k3x9' }).dedupeKey, { startsWith: 'CAMPAIGN:k3x9:' });
  assert.deepEqual(sends.buildSendsWhere({ campaign: "k3'; DROP" }).dedupeKey, { startsWith: 'CAMPAIGN:k3DROP:' });
});

test('id de campaña desde la clave anti-duplicados', () => {
  assert.equal(sends.campaignIdOf('CAMPAIGN:k3x9:42'), 'k3x9');
  assert.equal(sends.campaignIdOf('WELCOME_1:42'), null);
  assert.equal(sends.campaignIdOf(null), null);
});

test('paginación: límites y valores por defecto', () => {
  assert.deepEqual(sends.pageParams({}), { page: 1, pageSize: 25, skip: 0 });
  assert.deepEqual(sends.pageParams({ page: '3', pageSize: '10' }), { page: 3, pageSize: 10, skip: 20 });
  assert.equal(sends.pageParams({ pageSize: 9999 }).pageSize, 100);
  assert.equal(sends.pageParams({ page: -4 }).page, 1);
});
