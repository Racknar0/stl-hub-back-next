// Threads: conexión de la cuenta (OAuth de Threads) y publicación de videos con la API de Threads (Meta).
// El token de larga duración (60 días) se guarda en SystemSetting y se renueva solo; app id/secret vienen del .env.
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const GRAPH = 'https://graph.threads.net';
const API = `${GRAPH}/v1.0`;
const KEYS = { token: 'THREADS_TOKEN', expiresAt: 'THREADS_TOKEN_EXPIRES', account: 'THREADS_ACCOUNT' };
const SCOPES = ['threads_basic', 'threads_content_publish'];
export const THREADS_MAX_TEXT = 500;

export const threadsConfigured = () => !!(process.env.THREADS_APP_ID && process.env.THREADS_APP_SECRET && process.env.THREADS_REDIRECT_URI);

// Estados OAuth pendientes (anti-CSRF), válidos 10 minutos
const pendingStates = new Map();

export function getAuthUrl() {
  if (!threadsConfigured()) throw new Error('Faltan THREADS_APP_ID, THREADS_APP_SECRET o THREADS_REDIRECT_URI en el .env');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60000);
  const url = new URL('https://threads.net/oauth/authorize');
  url.search = new URLSearchParams({
    client_id: process.env.THREADS_APP_ID,
    redirect_uri: process.env.THREADS_REDIRECT_URI,
    scope: SCOPES.join(','),
    response_type: 'code',
    state,
  }).toString();
  return url.toString();
}

async function request(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, { method, ...(body && { body: new URLSearchParams(body) }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Threads: ${data.error?.message || data.error_message || `HTTP ${res.status}`}`);
  return data;
}

async function saveSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

async function saveToken(token, expiresIn) {
  await saveSetting(KEYS.token, token);
  await saveSetting(KEYS.expiresAt, String(Date.now() + Number(expiresIn || 0) * 1000));
}

/** Intercambia el código por un token de larga duración, lo guarda y devuelve la cuenta conectada. */
export async function handleCallback({ code, state }) {
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expires || expires < Date.now()) throw new Error('La autorización caducó o no es válida: vuelve a pulsar "Conectar Threads"');
  const short = await request(`${GRAPH}/oauth/access_token`, {
    method: 'POST',
    body: {
      client_id: process.env.THREADS_APP_ID,
      client_secret: process.env.THREADS_APP_SECRET,
      grant_type: 'authorization_code',
      redirect_uri: process.env.THREADS_REDIRECT_URI,
      code: String(code || '').replace(/#_$/, ''),
    },
  });
  const long = await request(`${GRAPH}/access_token?${new URLSearchParams({ grant_type: 'th_exchange_token', client_secret: process.env.THREADS_APP_SECRET, access_token: short.access_token })}`);
  await saveToken(long.access_token, long.expires_in);
  const account = await fetchAccount(long.access_token);
  await saveSetting(KEYS.account, JSON.stringify(account));
  return account;
}

/** Token válido; si le quedan menos de 7 días se renueva (Threads solo deja renovar tokens con más de 24 h). */
async function accessToken() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: [KEYS.token, KEYS.expiresAt] } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const token = byKey[KEYS.token];
  if (!token) throw new Error('Threads no está conectado: pulsa "Conectar Threads"');
  const expiresAt = Number(byKey[KEYS.expiresAt] || 0);
  if (expiresAt && expiresAt < Date.now()) throw new Error('La conexión con Threads caducó: desconecta y vuelve a conectar Threads');
  if (expiresAt && expiresAt - Date.now() < 7 * 86400000) {
    try {
      const refreshed = await request(`${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: token })}`);
      await saveToken(refreshed.access_token, refreshed.expires_in);
      return refreshed.access_token;
    } catch (e) {
      console.warn('[REELS][THREADS] No se pudo renovar el token:', e.message);
    }
  }
  return token;
}

async function fetchAccount(token) {
  const me = await request(`${API}/me?${new URLSearchParams({ fields: 'id,username,threads_profile_picture_url', access_token: token })}`);
  return { id: me.id, username: me.username, avatarUrl: me.threads_profile_picture_url || null };
}

export async function connectionStatus() {
  if (!threadsConfigured()) return { configured: false, connected: false };
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let account = null;
  try { account = byKey[KEYS.account] ? JSON.parse(byKey[KEYS.account]) : null; } catch { /* sin cuenta */ }
  return { configured: !!byKey[KEYS.token], connected: !!byKey[KEYS.token], account };
}

/** Borra el token (el acceso también se puede quitar en Threads: Configuración → Cuenta → Permisos de sitios web). */
export async function disconnect() {
  await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Texto del post: el caption sin cabecera/pie de Instagram + el link (en Threads los links sí son clicables). */
export function threadsText(body, link) {
  const tail = link ? `\n\n🔗 ${link}` : '';
  const room = THREADS_MAX_TEXT - tail.length;
  const text = String(body || '').trim();
  return `${text.length > room ? `${text.slice(0, room - 1).trimEnd()}…` : text}${tail}`;
}

/** Publica un video: Threads lo descarga de la URL pública, se espera a que lo procese y se publica. */
export async function publishVideo({ videoUrl, text }) {
  const token = await accessToken();
  const account = (await connectionStatus()).account;
  const userId = account?.id || 'me';
  const container = await request(`${API}/${userId}/threads`, {
    method: 'POST',
    body: { media_type: 'VIDEO', video_url: videoUrl, text: String(text || '').slice(0, THREADS_MAX_TEXT), access_token: token },
  });

  // Threads procesa el video en segundo plano: se consulta el estado hasta 10 minutos
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const s = await request(`${API}/${container.id}?${new URLSearchParams({ fields: 'status,error_message', access_token: token })}`);
    if (s.status === 'ERROR' || s.status === 'EXPIRED') throw new Error(`Threads no procesó el video: ${s.error_message || s.status}`);
    if (s.status === 'FINISHED') {
      const published = await request(`${API}/${userId}/threads_publish`, { method: 'POST', body: { creation_id: container.id, access_token: token } });
      const media = await request(`${API}/${published.id}?${new URLSearchParams({ fields: 'permalink', access_token: token })}`).catch(() => ({}));
      return { id: published.id, url: media.permalink || (account?.username ? `https://www.threads.net/@${account.username}` : null) };
    }
  }
  throw new Error('Threads sigue procesando el video tras 10 minutos: revisa tu perfil de Threads antes de reintentar');
}

export default { threadsConfigured, getAuthUrl, handleCallback, connectionStatus, disconnect, publishVideo, threadsText };
