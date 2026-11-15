import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCampaignInput,
  isCampaignEligible,
  sortRecipients,
  planCampaignRows,
  summarizeResults,
  isDue,
} from '../src/services/emailCampaigns.service.js';

const ok = { name: 'Black Friday', templateId: 30 };

test('validateCampaignInput: aplica valores por defecto', () => {
  const { value } = validateCampaignInput(ok);
  assert.equal(value.audience, 'ACTIVE');
  assert.equal(value.plan, 'all');
  assert.equal(value.dailyCap, 100);
  assert.equal(value.scheduledAt, null);
});

test('validateCampaignInput: rechaza datos malos', () => {
  assert.ok(validateCampaignInput({ ...ok, name: '  ' }).error);
  assert.ok(validateCampaignInput({ ...ok, templateId: 0 }).error);
  assert.ok(validateCampaignInput({ ...ok, audience: 'TODOS' }).error);
  assert.ok(validateCampaignInput({ ...ok, plan: 'gold' }).error);
  assert.ok(validateCampaignInput({ ...ok, dailyCap: 9999 }).error);
  assert.ok(validateCampaignInput({ ...ok, scheduledAt: 'mañana' }).error);
});

test('isCampaignEligible: respeta bajas, cuentas inactivas, etapa y plan', () => {
  const c = { isActive: true, optedOutAt: null, stage: 'ACTIVE', isPremium: false };
  assert.equal(isCampaignEligible(c, { audience: 'ACTIVE', plan: 'all' }), true);
  assert.equal(isCampaignEligible({ ...c, optedOutAt: new Date() }, { audience: 'ALL', plan: 'all' }), false);
  assert.equal(isCampaignEligible({ ...c, isActive: false }, { audience: 'ALL', plan: 'all' }), false);
  assert.equal(isCampaignEligible(c, { audience: 'DORMANT', plan: 'all' }), false);
  assert.equal(isCampaignEligible({ ...c, stage: 'OPTED_OUT' }, { audience: 'ALL', plan: 'all' }), false);
  assert.equal(isCampaignEligible({ ...c, stage: 'NEW' }, { audience: 'ALL', plan: 'all' }), true);
  assert.equal(isCampaignEligible({ ...c, isPremium: true }, { audience: 'ACTIVE', plan: 'free' }), false);
  assert.equal(isCampaignEligible(c, { audience: 'ACTIVE', plan: 'premium' }), false);
});

test('sortRecipients: primero los de señal más reciente', () => {
  const out = sortRecipients([
    { userId: 1, lastSignal: new Date('2026-01-01') },
    { userId: 2, lastSignal: new Date('2026-03-01') },
    { userId: 3, lastSignal: null },
  ]);
  assert.deepEqual(out.map((r) => r.userId), [2, 1, 3]);
});

test('planCampaignRows: reparte por días según el ritmo y marca la clave', () => {
  const now = new Date('2026-11-16T15:00:00Z');
  const recipients = [1, 2, 3].map((id) => ({ userId: id, contactId: id * 10, lastSignal: new Date(2026, 0, id) }));
  const rows = planCampaignRows({
    campaign: { id: 'abc123', templateId: 30, dailyCap: 2 },
    recipients,
    now,
    window: { startHour: 9, endHour: 20 },
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].dedupeKey, 'CAMPAIGN:abc123:3');
  assert.equal(rows[0].kind, 'OTHER');
  assert.equal(rows[0].status, 'QUEUED');
  assert.ok(rows[2].scheduledFor.getTime() - rows[0].scheduledFor.getTime() >= 20 * 3600 * 1000);
});

test('summarizeResults: totaliza por estado', () => {
  const out = summarizeResults(
    [
      { status: 'SENT', _count: { _all: 8 } },
      { status: 'QUEUED', _count: { _all: 2 } },
      { status: 'FAILED', _count: { _all: 1 } },
    ],
    { opened: 3, clicked: 1 }
  );
  assert.deepEqual(out, { queued: 2, sent: 8, failed: 1, skipped: 0, opened: 3, clicked: 1, total: 11 });
});

test('isDue: solo programadas con hora cumplida', () => {
  const now = new Date('2026-11-16T12:00:00Z');
  assert.equal(isDue({ status: 'SCHEDULED', scheduledAt: '2026-11-16T11:00:00Z' }, now), true);
  assert.equal(isDue({ status: 'SCHEDULED', scheduledAt: '2026-11-16T13:00:00Z' }, now), false);
  assert.equal(isDue({ status: 'DRAFT', scheduledAt: '2026-11-16T11:00:00Z' }, now), false);
});
