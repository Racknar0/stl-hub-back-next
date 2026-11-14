import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureMegaHttps, isMegaHttpsError } from '../src/utils/megaHttps.js';

const HTTPS = 'File transfer is done using HTTPS\n';
const HTTP = 'File transfer is done using HTTP\n';
const ENABLED = 'File transfer now uses HTTPS\n';
const OPTIONS = { quiet: true, timeoutMs: 10_000, autoAcceptTerms: false };

function runner(responses) {
  const calls = [];
  const runCmd = async (command, args, options) => {
    const index = calls.length;
    calls.push({ command, args: [...args], options: { ...options } });
    if (index >= responses.length) throw new Error('Unexpected command');
    const response = responses[index];
    if (response instanceof Error) throw response;
    return typeof response === 'string' ? { out: response, err: '' } : response;
  };
  return { runCmd, calls };
}

function assertCalls(calls, args) {
  assert.deepEqual(calls, args.map((value) => ({
    command: 'mega-https',
    args: value,
    options: OPTIONS,
  })));
}

function assertRequired(error, ctx = '') {
  assert.equal(isMegaHttpsError(error), true);
  assert.equal(error.code, 'MEGA_HTTPS_REQUIRED');
  assert.match(error.message, /no se inicia la transferencia/);
  if (ctx) assert.ok(error.message.includes(ctx));
  return true;
}

test('an already HTTPS session is queried without changing its configuration', async () => {
  const { runCmd, calls } = runner(['\r\n' + HTTPS]);
  await ensureMegaHttps(runCmd, 'already-secure');
  assertCalls(calls, [[]]);
});

test('HTTP is enabled and independently verified before returning', async () => {
  const { runCmd, calls } = runner([HTTP, ENABLED, HTTPS]);
  await ensureMegaHttps(runCmd, 'legacy-2.5.2');
  assertCalls(calls, [[], ['on'], []]);
});

test('an unknown initial state is repaired and must pass a fresh query', async () => {
  const { runCmd, calls } = runner(['Unrecognized status', '', HTTPS]);
  await ensureMegaHttps(runCmd);
  assertCalls(calls, [[], ['on'], []]);
});

test('modern MEGAcmd accepts the query-style response for its no-op on command', async () => {
  const { runCmd, calls } = runner([HTTP, HTTPS, HTTPS]);
  await ensureMegaHttps(runCmd, 'modern-2.6-and-later');
  assertCalls(calls, [[], ['on'], []]);
});

test('a configuration reset between invocations is detected and repaired each time', async () => {
  const { runCmd, calls } = runner([HTTP, ENABLED, HTTPS, HTTP, ENABLED, HTTPS]);
  await ensureMegaHttps(runCmd, 'account-main');
  await ensureMegaHttps(runCmd, 'account-backup');
  assertCalls(calls, [[], ['on'], [], [], ['on'], []]);
});

test('reusing a session still queries the current state on every invocation', async () => {
  const { runCmd, calls } = runner([HTTPS, HTTPS]);
  await ensureMegaHttps(runCmd, 'same-session');
  await ensureMegaHttps(runCmd, 'same-session');
  assertCalls(calls, [[], []]);
});

for (const [phase, responses, expectedArgs] of [
  ['initial query', [new Error('private-ticket-123')], [[]]],
  ['enable command', [HTTP, new Error('private-password-123')], [[], ['on']]],
  ['verification query', [HTTP, ENABLED, new Error('private-proxy-123')], [[], ['on'], []]],
]) {
  test(`failure in the ${phase} prevents success and hides command details`, async () => {
    const { runCmd, calls } = runner(responses);
    await assert.rejects(ensureMegaHttps(runCmd, 'failure-context'), (error) => {
      assertRequired(error, 'failure-context');
      assert.doesNotMatch(error.message, /private-|ticket-123|password-123|proxy-123/);
      return true;
    });
    assertCalls(calls, expectedArgs);
  });
}

for (const invalidStatus of [
  HTTP,
  '',
  'HTTPS is disabled',
  'Usage: https [on|off]',
  'HTTPS cannot be turned on',
  'File transfer is done using HTTPS, but another mode is active',
]) {
  test(`an apparent on success cannot override an unverified status: ${JSON.stringify(invalidStatus)}`, async () => {
    const { runCmd, calls } = runner([invalidStatus, ENABLED, invalidStatus]);
    await assert.rejects(ensureMegaHttps(runCmd), assertRequired);
    assertCalls(calls, [[], ['on'], []]);
  });
}

test('an enable response alone does not prove that the query reports HTTPS', async () => {
  const { runCmd, calls } = runner([HTTP, ENABLED, ENABLED]);
  await assert.rejects(ensureMegaHttps(runCmd), assertRequired);
  assertCalls(calls, [[], ['on'], []]);
});

test('compatible injected executors may return stdout or a plain string', async () => {
  const first = runner([{ stdout: HTTPS }]);
  await ensureMegaHttps(first.runCmd);
  assertCalls(first.calls, [[]]);

  const calls = [];
  await ensureMegaHttps(async (command, args, options) => {
    calls.push({ command, args, options });
    return HTTPS;
  });
  assertCalls(calls, [[]]);
});

test('unrelated failures are not classified as HTTPS policy errors', () => {
  assert.equal(isMegaHttpsError(undefined), false);
  assert.equal(isMegaHttpsError(null), false);
  assert.equal(isMegaHttpsError(new Error('MEGA_HTTPS_REQUIRED')), false);
  assert.equal(isMegaHttpsError({ code: 'ETIMEDOUT' }), false);
  assert.equal(isMegaHttpsError({ code: 'MEGA_HTTPS_REQUIRED' }), true);
});
