// Mastodon: conexión con la URL del servidor y un token de acceso (Preferencias → Desarrollo → Nueva aplicación,
// permisos write:statuses, write:media y read:statuses) y publicación de videos con la API de Mastodon.
// El token no caduca; se guarda en SystemSetting.
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const KEYS = { instance: 'MASTODON_INSTANCE', token: 'MASTODON_TOKEN', account: 'MASTODON_ACCOUNT' };
export const MASTODON_MAX_TEXT = 500;
const MAX_TAGS = 5;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function readSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function saveSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** URL base del servidor a partir de lo que escriba el usuario (mastodon.social, https://mastodon.social/@x…). */
export function normalizeInstance(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^@?[^@]+@/, '')}`);
    return `https://${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

async function api(instance, token, pathname, { method = 'GET', body, json } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload = body;
  if (json) { payload = JSON.stringify(json); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(`${instance}${pathname}`, { method, headers, ...(payload && { body: payload }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`Mastodon: ${data.error || `HTTP ${res.status}`}`), { status: res.status });
  return { status: res.status, data };
}

/** Conecta la cuenta: comprueba el token con el servidor y lo guarda. */
export async function connect({ instance, token }) {
  const base = normalizeInstance(instance);
  const tk = String(token || '').trim();
  if (!base) throw Object.assign(new Error('Escribe el servidor de Mastodon (p. ej. mastodon.social)'), { status: 400 });
  if (tk.length < 20) throw Object.assign(new Error('Pega el "Tu token de acceso" de la aplicación creada en Preferencias → Desarrollo'), { status: 400 });
  const { data: me } = await api(base, tk, '/api/v1/accounts/verify_credentials');
  const account = { id: me.id, username: me.username, acct: `${me.username}@${new URL(base).host}`, url: me.url };
  await saveSetting(KEYS.instance, base);
  await saveSetting(KEYS.token, tk);
  await saveSetting(KEYS.account, JSON.stringify(account));
  return account;
}

export async function connectionStatus() {
  const s = await readSettings();
  let account = null;
  try { account = s[KEYS.account] ? JSON.parse(s[KEYS.account]) : null; } catch { /* sin cuenta */ }
  const connected = !!(s[KEYS.instance] && s[KEYS.token]);
  return { configured: connected, connected, account: connected ? account : null };
}

/** Borra el token (en Mastodon también se puede borrar la aplicación en Preferencias → Desarrollo). */
export async function disconnect() {
  await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
}

async function credentials() {
  const s = await readSettings();
  if (!s[KEYS.instance] || !s[KEYS.token]) throw new Error('Mastodon no está conectado: pulsa "Conectar Mastodon"');
  return { instance: s[KEYS.instance], token: s[KEYS.token] };
}

/**
 * Texto del post: cuerpo del caption + link + hasta 5 hashtags (en Mastodon no hay algoritmo: los hashtags son
 * la forma de que te encuentren). Se recorta el cuerpo para no pasar de 500 caracteres.
 */
export function mastodonText(body, link, hashtags = []) {
  const tags = [...new Set((Array.isArray(hashtags) ? hashtags : [])
    .map(t => String(t).replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(t => t && !/^\d+$/.test(t)))].slice(0, MAX_TAGS);
  const tail = `${link ? `\n\n🔗 ${link}` : ''}${tags.length ? `\n\n${tags.map(t => `#${t}`).join(' ')}` : ''}`;
  const room = MASTODON_MAX_TEXT - [...tail].length;
  const chars = [...String(body || '').trim()];
  const text = chars.length > room ? `${chars.slice(0, room - 1).join('').trimEnd()}…` : chars.join('');
  return `${text}${tail}`;
}

/** Sube el video y espera a que el servidor lo procese; devuelve el id del adjunto. */
async function uploadVideo(instance, token, videoAbsPath, description) {
  const form = new FormData();
  const bytes = await fs.promises.readFile(videoAbsPath);
  form.append('file', new Blob([bytes], { type: 'video/mp4' }), path.basename(videoAbsPath));
  if (description) form.append('description', String(description).slice(0, 1500));
  const { status, data } = await api(instance, token, '/api/v2/media', { method: 'POST', body: form });
  // 200 = listo; 202 = procesando (url todavía en null)
  if (status === 200 && data.url) return data.id;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const res = await fetch(`${instance}/api/v1/media/${data.id}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 200) {
      const media = await res.json().catch(() => ({}));
      if (media.url) return data.id;
    } else if (res.status !== 206) {
      throw new Error(`Mastodon no procesó el video (HTTP ${res.status})`);
    }
  }
  throw new Error('Mastodon sigue procesando el video tras 5 minutos: revisa tu perfil antes de reintentar');
}

/** Publica un video con su texto. Devuelve { id, url }. */
export async function publishVideo({ videoAbsPath, text, alt = '' }) {
  const { instance, token } = await credentials();
  const mediaId = await uploadVideo(instance, token, videoAbsPath, alt);
  const { data } = await api(instance, token, '/api/v1/statuses', {
    method: 'POST',
    json: { status: String(text || '').slice(0, MASTODON_MAX_TEXT), media_ids: [mediaId], visibility: 'public', language: 'en' },
  });
  return { id: String(data.id), url: data.url || data.uri };
}

/** Métricas de un post (Mastodon no da vistas: favoritos, impulsos y respuestas). */
export async function postMetrics(statusId) {
  const { instance, token } = await credentials();
  const { data } = await api(instance, token, `/api/v1/statuses/${encodeURIComponent(statusId)}`);
  return { views: null, likes: data.favourites_count ?? 0, comments: data.replies_count ?? 0, shares: data.reblogs_count ?? 0 };
}

export default { connect, connectionStatus, disconnect, publishVideo, mastodonText, postMetrics, normalizeInstance };
