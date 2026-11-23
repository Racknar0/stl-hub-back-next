// Tumblr: conexión del blog con OAuth 2 y publicación de videos con la API v2 (formato NPF).
// La app de Tumblr (client id/secret) se guarda desde el dashboard en SystemSetting (o en el .env), y el token
// (caduca en ~40 min) se renueva solo con el refresh token (permiso offline_access).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const API = 'https://api.tumblr.com/v2';
const KEYS = { app: 'TUMBLR_APP', token: 'TUMBLR_TOKEN', account: 'TUMBLR_ACCOUNT' };
const SCOPES = ['basic', 'write', 'offline_access'];
// URL a la que Tumblr vuelve tras autorizar (la misma que se registra en la app de Tumblr)
const redirectUri = () => process.env.TUMBLR_REDIRECT_URI || 'https://stlgratis.com/api/reels/tumblr/callback';

async function readSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const out = {};
  for (const r of rows) { try { out[r.key] = JSON.parse(r.value); } catch { /* valor corrupto: se ignora */ } }
  return out;
}

async function saveSetting(key, value) {
  const v = JSON.stringify(value);
  await prisma.systemSetting.upsert({ where: { key }, update: { value: v }, create: { key, value: v } });
}

async function appCredentials() {
  if (process.env.TUMBLR_CLIENT_ID && process.env.TUMBLR_CLIENT_SECRET) return { clientId: process.env.TUMBLR_CLIENT_ID, clientSecret: process.env.TUMBLR_CLIENT_SECRET };
  const s = await readSettings();
  return s[KEYS.app]?.clientId && s[KEYS.app]?.clientSecret ? s[KEYS.app] : null;
}

/** Guarda la app registrada en tumblr.com/oauth/apps (OAuth Consumer Key y Secret Key). */
export async function saveApp({ clientId, clientSecret }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!/^[A-Za-z0-9]{20,}$/.test(id) || !/^[A-Za-z0-9]{20,}$/.test(secret)) {
    throw Object.assign(new Error('Pega la "OAuth Consumer Key" y la "Secret Key" de tu app en tumblr.com/oauth/apps'), { status: 400 });
  }
  await saveSetting(KEYS.app, { clientId: id, clientSecret: secret });
}

// Estados OAuth pendientes (anti-CSRF), válidos 10 minutos
const pendingStates = new Map();

export async function getAuthUrl() {
  const app = await appCredentials();
  if (!app) throw Object.assign(new Error('Falta la app de Tumblr: pega su Consumer Key y Secret Key'), { status: 400, code: 'NO_APP' });
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60000);
  const url = new URL('https://www.tumblr.com/oauth2/authorize');
  url.search = new URLSearchParams({ client_id: app.clientId, response_type: 'code', scope: SCOPES.join(' '), state, redirect_uri: redirectUri() }).toString();
  return url.toString();
}

async function tokenRequest(body) {
  const res = await fetch(`${API}/oauth2/token`, { method: 'POST', body: new URLSearchParams(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(`Tumblr: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  return data;
}

async function saveToken(t) {
  await saveSetting(KEYS.token, { access: t.access_token, refresh: t.refresh_token, expiresAt: Date.now() + Number(t.expires_in || 0) * 1000 });
}

async function api(pathname, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers: { Authorization: `Bearer ${token}` }, ...(body && { body }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data.errors?.[0]?.detail || data.errors?.[0]?.title || data.meta?.msg;
    const extra = data.errors ? ` ${JSON.stringify(data.errors).slice(0, 300)}` : '';
    throw Object.assign(new Error(`Tumblr: ${detail || `HTTP ${res.status}`}${extra}`), { status: res.status });
  }
  return data.response;
}

/** Intercambia el código por el token, elige el blog principal y lo guarda. */
export async function handleCallback({ code, state }) {
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expires || expires < Date.now()) throw new Error('La autorización caducó o no es válida: vuelve a pulsar "Conectar Tumblr"');
  const app = await appCredentials();
  if (!app) throw new Error('Falta la app de Tumblr');
  const token = await tokenRequest({ grant_type: 'authorization_code', code: String(code || ''), client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri() });
  await saveToken(token);
  const info = await api('/user/info', { token: token.access_token });
  const blog = info.user?.blogs?.find(b => b.primary) || info.user?.blogs?.[0];
  if (!blog) throw new Error('Tumblr: la cuenta no tiene blogs');
  const account = { blog: blog.name, title: blog.title || blog.name, url: blog.url || `https://www.tumblr.com/${blog.name}`, uuid: blog.uuid };
  await saveSetting(KEYS.account, account);
  return account;
}

/** Token válido; si le quedan menos de 2 minutos se renueva (el refresh token también cambia en cada renovación). */
async function accessToken() {
  const s = await readSettings();
  const t = s[KEYS.token];
  if (!t?.access) throw new Error('Tumblr no está conectado: pulsa "Conectar Tumblr"');
  if (t.expiresAt && t.expiresAt - Date.now() > 2 * 60000) return t.access;
  if (!t.refresh) throw new Error('La conexión con Tumblr caducó: desconecta y vuelve a conectar Tumblr');
  const app = await appCredentials();
  const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: app.clientId, client_secret: app.clientSecret });
  await saveToken({ ...fresh, refresh_token: fresh.refresh_token || t.refresh });
  return fresh.access_token;
}

export async function connectionStatus() {
  const [s, app] = await Promise.all([readSettings(), appCredentials()]);
  const connected = !!s[KEYS.token]?.access;
  return { appConfigured: !!app, configured: connected, connected, account: connected ? s[KEYS.account] || null : null };
}

/** Borra el token y el blog (la app se conserva; el acceso también se revoca en Tumblr: Configuración → Aplicaciones). */
export async function disconnect() {
  await prisma.systemSetting.deleteMany({ where: { key: { in: [KEYS.token, KEYS.account] } } });
}

/** Etiquetas de Tumblr: sin #, sin comas y como mucho 20 (las de Tumblr pueden llevar espacios). */
export function tumblrTags(hashtags) {
  const list = (Array.isArray(hashtags) ? hashtags : []).map(t => String(t).replace(/^#+/, '').replace(/,/g, ' ').trim()).filter(Boolean);
  return [...new Set(list)].slice(0, 20);
}

/**
 * Publica un video en el blog conectado (formato NPF: bloque de video subido como archivo + texto + tarjeta de enlace).
 * Devuelve { id, url }.
 */
export async function publishVideo({ videoAbsPath, text, link, linkTitle, tags = [] }) {
  const token = await accessToken();
  const account = (await readSettings())[KEYS.account];
  if (!account?.blog) throw new Error('Tumblr: no hay blog conectado');
  // En NPF el bloque de video lleva un solo objeto media (no una lista como las imágenes)
  const content = [{ type: 'video', media: { type: 'video/mp4', identifier: 'video-file' } }];
  if (String(text || '').trim()) content.push({ type: 'text', text: String(text).trim() });
  if (link) content.push({ type: 'link', url: link, ...(linkTitle && { title: linkTitle }) });

  const form = new FormData();
  form.append('json', new Blob([JSON.stringify({ content, state: 'published', tags: tumblrTags(tags).join(',') })], { type: 'application/json' }));
  const bytes = await fs.promises.readFile(videoAbsPath);
  form.append('video-file', new Blob([bytes], { type: 'video/mp4' }), path.basename(videoAbsPath));
  const res = await api(`/blog/${encodeURIComponent(account.blog)}/posts`, { token, method: 'POST', body: form });
  const id = String(res.id_string || res.id);
  return { id, url: `https://www.tumblr.com/${account.blog}/${id}`, blog: account.blog };
}

/** Notas de un post (me gusta + reblogs + respuestas): Tumblr no da vistas por la API. */
export async function postMetrics(postId) {
  const token = await accessToken();
  const account = (await readSettings())[KEYS.account];
  const res = await api(`/blog/${encodeURIComponent(account.blog)}/posts?id=${encodeURIComponent(postId)}&notes_info=false`, { token });
  const p = res.posts?.[0];
  if (!p) throw new Error('Tumblr: no se encontró el post');
  return { views: null, likes: p.note_count ?? 0 };
}

export default { saveApp, getAuthUrl, handleCallback, connectionStatus, disconnect, publishVideo, postMetrics, tumblrTags };
