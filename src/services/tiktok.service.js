// TikTok: conexión de la cuenta (Login Kit, OAuth 2.0) y publicación directa con la Content Posting API.
// El refresh token se guarda en SystemSetting (como YouTube); client key/secret vienen del .env.
import crypto from 'crypto';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API = 'https://open.tiktokapis.com/v2';
const KEYS = { refreshToken: 'TIKTOK_REFRESH_TOKEN', account: 'TIKTOK_ACCOUNT' };
const SCOPES = ['user.info.basic', 'video.publish'];
export const PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

export const tiktokConfigured = () => !!(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET && process.env.TIKTOK_REDIRECT_URI);

// Estados OAuth pendientes (anti-CSRF), válidos 10 minutos
const pendingStates = new Map();

export function getAuthUrl() {
  if (!tiktokConfigured()) throw new Error('Faltan TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET o TIKTOK_REDIRECT_URI en el .env');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60000);
  const url = new URL('https://www.tiktok.com/v2/auth/authorize/');
  url.search = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY,
    response_type: 'code',
    scope: SCOPES.join(','),
    redirect_uri: process.env.TIKTOK_REDIRECT_URI,
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const res = await fetch(`${API}/oauth/token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`TikTok OAuth: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  return data;
}

async function saveSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

let accessCache = null;
function cacheTokens(tokens) {
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + (Number(tokens.expires_in || 0) - 60) * 1000 };
}

/** Intercambia el código del callback, guarda el refresh token y devuelve la cuenta conectada. */
export async function handleCallback({ code, state }) {
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expires || expires < Date.now()) throw new Error('La autorización caducó o no es válida: vuelve a pulsar "Conectar TikTok"');
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: process.env.TIKTOK_REDIRECT_URI });
  const granted = String(tokens.scope || '').split(',');
  if (!granted.includes('video.publish')) throw new Error('No se concedió el permiso para publicar videos: vuelve a conectar y acéptalo');
  cacheTokens(tokens);
  await saveSetting(KEYS.refreshToken, tokens.refresh_token);
  const account = await fetchAccount();
  await saveSetting(KEYS.account, JSON.stringify(account));
  return account;
}

async function accessToken() {
  if (accessCache && accessCache.expiresAt > Date.now()) return accessCache.token;
  const row = await prisma.systemSetting.findUnique({ where: { key: KEYS.refreshToken } });
  if (!row?.value) throw new Error('TikTok no está conectado: pulsa "Conectar TikTok"');
  const tokens = await tokenRequest({ refresh_token: row.value, grant_type: 'refresh_token' });
  cacheTokens(tokens);
  // TikTok puede rotar el refresh token: se guarda siempre el último
  if (tokens.refresh_token && tokens.refresh_token !== row.value) await saveSetting(KEYS.refreshToken, tokens.refresh_token);
  return accessCache.token;
}

async function api(pathname, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && { 'Content-Type': 'application/json; charset=UTF-8' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.error?.code && data.error.code !== 'ok')) {
    throw new Error(`TikTok: ${data.error?.message || data.error?.code || `HTTP ${res.status}`}`);
  }
  return data.data || {};
}

async function fetchAccount() {
  const data = await api('/user/info/?fields=open_id,avatar_url,display_name');
  const user = data.user || {};
  return { openId: user.open_id, displayName: user.display_name, avatarUrl: user.avatar_url };
}

export async function connectionStatus() {
  if (!tiktokConfigured()) return { configured: false, connected: false };
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let account = null;
  try { account = byKey[KEYS.account] ? JSON.parse(byKey[KEYS.account]) : null; } catch { /* sin cuenta */ }
  return { configured: !!byKey[KEYS.refreshToken], connected: !!byKey[KEYS.refreshToken], account };
}

export async function disconnect() {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEYS.refreshToken } });
  if (row?.value) {
    const token = accessCache?.token || row.value;
    await fetch(`${API}/oauth/revoke/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY, client_secret: process.env.TIKTOK_CLIENT_SECRET, token }),
    }).catch(() => {});
  }
  await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
  accessCache = null;
}

/**
 * Datos del creador que TikTok exige mostrar antes de publicar: nombre y avatar, privacidades permitidas,
 * si tiene desactivados comentarios/dúo/stitch y la duración máxima de video.
 */
export async function creatorInfo() {
  const d = await api('/post/publish/creator_info/query/', { method: 'POST', body: {} });
  return {
    username: d.creator_username,
    nickname: d.creator_nickname,
    avatarUrl: d.creator_avatar_url,
    privacyLevelOptions: d.privacy_level_options || [],
    commentDisabled: !!d.comment_disabled,
    duetDisabled: !!d.duet_disabled,
    stitchDisabled: !!d.stitch_disabled,
    maxVideoDurationSec: d.max_video_post_duration_sec || null,
  };
}

/** Comprueba las opciones que el usuario eligió para TikTok (TikTok no permite valores por defecto). */
export function tiktokOptionsProblem(options) {
  const o = options || {};
  if (!PRIVACY_LEVELS.includes(o.privacyLevel)) return 'privacidad de TikTok';
  if (o.commercial && !o.yourBrand && !o.brandedContent) return 'tipo de contenido comercial de TikTok';
  if (o.brandedContent && o.privacyLevel === 'SELF_ONLY') return 'privacidad de TikTok compatible con contenido de marca (no puede ser "Solo yo")';
  return null;
}

const CHUNK = 10 * 1024 * 1024;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Publica un video directamente en la cuenta conectada (subida por archivo) y espera a que TikTok lo procese. */
export async function publishVideo({ videoAbsPath, caption, options }) {
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
  const problem = tiktokOptionsProblem(options);
  if (problem) throw new Error(`Falta elegir: ${problem}`);
  const creator = await creatorInfo();
  if (!creator.privacyLevelOptions.includes(options.privacyLevel)) {
    throw new Error(`La cuenta de TikTok no permite la privacidad "${options.privacyLevel}" (permite: ${creator.privacyLevelOptions.join(', ')})`);
  }

  const file = await fs.promises.readFile(videoAbsPath);
  const size = file.length;
  // Un solo trozo si cabe (hasta 64 MB); si no, trozos de 10 MB y el último se queda con el resto
  const chunkSize = size <= 64 * 1024 * 1024 ? size : CHUNK;
  const totalChunks = Math.max(1, Math.floor(size / chunkSize));

  const init = await api('/post/publish/video/init/', {
    method: 'POST',
    body: {
      post_info: {
        title: String(caption || '').slice(0, 2200),
        privacy_level: options.privacyLevel,
        disable_comment: !options.allowComment || creator.commentDisabled,
        disable_duet: !options.allowDuet || creator.duetDisabled,
        disable_stitch: !options.allowStitch || creator.stitchDisabled,
        brand_organic_toggle: !!(options.commercial && options.yourBrand),
        brand_content_toggle: !!(options.commercial && options.brandedContent),
      },
      source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: totalChunks },
    },
  });

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = i === totalChunks - 1 ? size - 1 : start + chunkSize - 1;
    const put = await fetch(init.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
      body: file.subarray(start, end + 1),
    });
    if (![200, 201, 206].includes(put.status)) throw new Error(`TikTok rechazó la subida del video (HTTP ${put.status})`);
  }

  // TikTok procesa el video en segundo plano: se consulta el estado hasta 10 minutos
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const s = await api('/post/publish/status/fetch/', { method: 'POST', body: { publish_id: init.publish_id } });
    if (s.status === 'FAILED') throw new Error(`TikTok no publicó el video: ${s.fail_reason || 'error desconocido'}`);
    if (s.status === 'PUBLISH_COMPLETE') {
      const postId = (s.publicaly_available_post_id || [])[0];
      const profile = creator.username ? `https://www.tiktok.com/@${creator.username}` : null;
      return {
        id: postId ? String(postId) : init.publish_id,
        url: postId && profile ? `${profile}/video/${postId}` : profile,
        privacy: options.privacyLevel,
      };
    }
  }
  throw new Error('TikTok sigue procesando el video tras 10 minutos: revisa la app de TikTok antes de reintentar');
}

export default { tiktokConfigured, getAuthUrl, handleCallback, connectionStatus, disconnect, creatorInfo, publishVideo, tiktokOptionsProblem };
