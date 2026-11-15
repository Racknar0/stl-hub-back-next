import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleStep, clampToSendWindow, timezoneForCountry } from '../src/utils/emailSchedule.js';

process.env.EMAIL_UNSUBSCRIBE_SECRET = 'test-secret';
// Se prueba el export por defecto, que es el que usan los controladores.
const engine = (await import('../src/services/emailEngine.service.js')).default;

const window = { startHour: 9, endHour: 20 };

test('país desconocido usa zona de Colombia', () => {
  assert.equal(timezoneForCountry('ZZ'), 'America/Bogota');
  assert.equal(timezoneForCountry('mx'), 'America/Mexico_City');
});

test('antes de la ventana pasa a las 9 locales; tras las 20 al día siguiente', () => {
  // Bogotá es UTC-5
  const early = clampToSendWindow(new Date('2026-11-14T08:00:00Z'), 'America/Bogota', window); // 03:00 local
  assert.equal(early.toISOString(), '2026-11-14T14:00:00.000Z');
  const late = clampToSendWindow(new Date('2026-11-15T02:00:00Z'), 'America/Bogota', window); // 21:00 local del 14
  assert.equal(late.toISOString(), '2026-11-15T14:00:00.000Z');
  const inside = new Date('2026-11-14T18:00:00Z');
  assert.equal(clampToSendWindow(inside, 'America/Bogota', window).getTime(), inside.getTime());
});

test('paso de días conserva la hora local del registro', () => {
  const createdAt = '2026-11-14T18:30:00Z'; // 13:30 en Bogotá
  const at = scheduleStep({ createdAt, country: 'CO', step: { delayDays: 3 }, window });
  assert.equal(at.toISOString(), '2026-11-17T18:30:00.000Z');
});

test('paso de horas se ajusta a la ventana', () => {
  const createdAt = '2026-11-15T01:30:00Z'; // 20:30 en Bogotá
  const at = scheduleStep({ createdAt, country: 'CO', step: { delayHours: 1 }, window });
  assert.equal(at.toISOString(), '2026-11-15T14:00:00.000Z');
});

test('estado inicial: corte, baja y retraso', () => {
  const start = new Date('2026-11-20T00:00:00Z');
  const now = new Date('2026-11-20T12:00:00Z');
  const ok = { start, now, staleHours: 24 };
  assert.equal(engine.initialStatus({ ...ok, scheduledFor: new Date('2026-11-19T10:00:00Z') }), 'SKIPPED');
  assert.equal(engine.initialStatus({ ...ok, scheduledFor: new Date('2026-11-21T10:00:00Z') }), 'QUEUED');
  assert.equal(engine.initialStatus({ ...ok, scheduledFor: new Date('2026-11-21T10:00:00Z'), optedOut: true }), 'SKIPPED');
  assert.equal(
    engine.initialStatus({ start, now: new Date('2026-11-23T00:00:00Z'), scheduledFor: new Date('2026-11-21T10:00:00Z') }),
    'SKIPPED'
  );
});

test('cupo restante nunca es negativo', () => {
  assert.equal(engine.remainingQuota({ limit: 300, reserve: 50, sentToday: 100 }), 150);
  assert.equal(engine.remainingQuota({ limit: 300, reserve: 50, sentToday: 400 }), 0);
});

test('descartes antes de enviar', () => {
  const user = { isActive: true };
  assert.equal(engine.skipReason({ step: { sales: true }, user, contact: {}, isPremium: true }), 'premium');
  assert.equal(engine.skipReason({ step: { sales: false }, user, contact: {}, isPremium: true }), null);
  assert.equal(engine.skipReason({ step: {}, user, contact: { optedOutAt: new Date() } }), 'baja');
  assert.equal(engine.skipReason({ step: {}, user: { isActive: false }, contact: {} }), 'cuenta inactiva');
});

test('configuración: el panel manda sobre el entorno', () => {
  const env = { EMAIL_DAILY_LIMIT: '300', EMAIL_ENGINE_ENABLED: 'false' };
  const cfg = engine.buildConfig(env, { EMAIL_DAILY_LIMIT: '200', EMAIL_ENGINE_ENABLED: 'true', EMAIL_ENGINE_START: '2026-11-20T00:00:00Z' });
  assert.equal(cfg.dailyLimit, 200);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.start.toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(engine.buildConfig({}, {}).dailyLimit, 300);
  assert.equal(engine.buildConfig({}, {}).enabled, false);
});

test('ajustes del panel: validaciones', () => {
  const current = engine.buildConfig({}, {});
  const ok = { current, hasSecret: true };
  assert.ok(engine.parseEngineSettings({ enabled: true }, ok).error, 'sin fecha no enciende');
  assert.ok(engine.parseEngineSettings({ enabled: true, start: '2026-11-20T00:00:00Z' }, { current, hasSecret: false }).error);
  assert.ok(!engine.parseEngineSettings({ enabled: true, start: '2026-11-20T00:00:00Z' }, ok).error);
  assert.ok(engine.parseEngineSettings({ start: 'no-es-fecha' }, ok).error);
  assert.ok(engine.parseEngineSettings({ dailyLimit: 40 }, ok).error, 'reserva 50 >= límite 40');
  assert.equal(engine.parseEngineSettings({ dailyLimit: 250 }, ok).values.EMAIL_DAILY_LIMIT, '250');
});

test('avisos de Premium: día de fin, fecha legible y descartes', () => {
  // 2026-11-20 03:00Z es todavía el 19 en Colombia
  assert.equal(engine.endDayKey('2026-11-20T03:00:00Z'), '2026-11-19');
  assert.equal(engine.formatExpiryDate('2026-11-19', 'es'), '19 de noviembre');
  assert.equal(engine.formatExpiryDate('2026-11-19', 'en'), 'November 19');

  const now = new Date('2026-11-17T15:00:00Z');
  const key = 'PREMIUM_EXPIRING:7:2026-11-19';
  // mismo período: se envía; período renovado: se descarta
  assert.equal(engine.premiumNoticeSkip({ kind: 'PREMIUM_EXPIRING', dedupeKey: key, currentEnd: '2026-11-20T03:00:00Z', now }), null);
  assert.equal(engine.premiumNoticeSkip({ kind: 'PREMIUM_EXPIRING', dedupeKey: key, currentEnd: '2026-12-19T15:00:00Z', now }), 'renovó');
  // vencido: si ya volvió a ser Premium, se descarta
  const keyGone = 'PREMIUM_EXPIRED:7:2026-11-10';
  assert.equal(engine.premiumNoticeSkip({ kind: 'PREMIUM_EXPIRED', dedupeKey: keyGone, currentEnd: '2026-11-11T00:00:00Z', now }), null);
  assert.equal(engine.premiumNoticeSkip({ kind: 'PREMIUM_EXPIRED', dedupeKey: keyGone, currentEnd: '2026-12-10T00:00:00Z', now }), 'ya es Premium');
});

test('token de baja: válido, manipulado y sin secreto', () => {
  const token = engine.buildUnsubscribeToken(42);
  assert.equal(engine.verifyUnsubscribeToken(token), 42);
  assert.equal(engine.verifyUnsubscribeToken(`43.${token.split('.')[1]}`), null);
  assert.equal(engine.verifyUnsubscribeToken('basura'), null);
});

test('cupo: se cuenta una ventana móvil de 24 horas', () => {
  const now = new Date('2026-11-15T01:05:00Z');
  assert.equal(engine.quotaWindowStart(now).toISOString(), '2026-11-14T01:05:00.000Z');
});
