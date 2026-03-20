const switchRequests = new Map(); // itemId -> { requestedAt, reason }
const activeUploads = new Map(); // itemId -> { phase, accountId, proxyUrl, cancel }

function toItemId(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

export function registerActiveBatchUpload(itemId, context = {}) {
  const id = toItemId(itemId);
  if (!id) return;
  activeUploads.set(id, {
    phase: String(context.phase || '').toLowerCase() || 'main',
    accountId: Number(context.accountId || 0) || 0,
    proxyUrl: String(context.proxyUrl || ''),
    cancel: typeof context.cancel === 'function' ? context.cancel : null,
    startedAt: Date.now(),
  });
}

export function updateActiveBatchUpload(itemId, patch = {}) {
  const id = toItemId(itemId);
  if (!id) return;
  const prev = activeUploads.get(id);
  if (!prev) return;
  activeUploads.set(id, {
    ...prev,
    ...patch,
    proxyUrl: patch.proxyUrl !== undefined ? String(patch.proxyUrl || '') : prev.proxyUrl,
  });
}

export function clearActiveBatchUpload(itemId) {
  const id = toItemId(itemId);
  if (!id) return;
  activeUploads.delete(id);
}

export function consumeBatchProxySwitchRequest(itemId) {
  const id = toItemId(itemId);
  if (!id) return null;
  const req = switchRequests.get(id) || null;
  if (req) switchRequests.delete(id);
  return req;
}

export function hasBatchProxySwitchRequest(itemId) {
  const id = toItemId(itemId);
  if (!id) return false;
  return switchRequests.has(id);
}

export function requestBatchProxySwitch(itemId, reason = 'manual') {
  const id = toItemId(itemId);
  if (!id) return { ok: false, message: 'invalid itemId' };

  switchRequests.set(id, {
    requestedAt: Date.now(),
    reason: String(reason || 'manual').slice(0, 64),
  });

  const active = activeUploads.get(id);
  let cancelSent = false;
  if (active?.cancel) {
    try {
      active.cancel('manual-switch-proxy');
      cancelSent = true;
    } catch {}
  }

  return {
    ok: true,
    itemId: id,
    cancelSent,
    phase: active?.phase || null,
    accountId: active?.accountId || null,
    proxyUrl: active?.proxyUrl || null,
  };
}

export function getActiveBatchUploadInfo(itemId) {
  const id = toItemId(itemId);
  if (!id) return null;
  const active = activeUploads.get(id);
  if (!active) return null;
  return {
    itemId: id,
    phase: active.phase,
    accountId: active.accountId,
    proxyUrl: active.proxyUrl,
    startedAt: active.startedAt,
    runningForMs: Date.now() - Number(active.startedAt || Date.now()),
  };
}
