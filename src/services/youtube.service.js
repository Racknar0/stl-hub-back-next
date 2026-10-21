// YouTube Shorts: conexión del canal (OAuth de Google) y subida de videos con la YouTube Data API v3.
// El refresh token se guarda en SystemSetting (como Pinterest); el client id/secret vienen del .env.
import crypto from 'crypto';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const KEYS = { refreshToken: 'YOUTUBE_REFRESH_TOKEN', channel: 'YOUTUBE_CHANNEL' };
const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export const youtubeConfigured = () => !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REDIRECT_URI);

// Estados OAuth pendientes (anti-CSRF), válidos 10 minutos
const pendingStates = new Map();

export function getAuthUrl() {
  if (!youtubeConfigured()) throw new Error('Faltan YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET o YOUTUBE_REDIRECT_URI en el .env');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now() + 10 * 60000);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID,
    redirect_uri: process.env.YOUTUBE_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent', // fuerza el refresh token aunque ya se haya autorizado antes
    include_granted_scopes: 'true',
    state,
  }).toString();
  return url.toString();
}

async function tokenRequest(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID, client_secret: process.env.YOUTUBE_CLIENT_SECRET, ...params }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`Google OAuth: ${data.error_description || data.error || `HTTP ${res.status}`}`);
  return data;
}

async function saveSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

/** Intercambia el código del callback, guarda el refresh token y devuelve el canal conectado. */
export async function handleCallback({ code, state }) {
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expires || expires < Date.now()) throw new Error('La autorización caducó o no es válida: vuelve a pulsar "Conectar YouTube"');
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: process.env.YOUTUBE_REDIRECT_URI });
  if (!tokens.refresh_token) throw new Error('Google no devolvió el refresh token: quita el acceso de la app en tu cuenta de Google y vuelve a conectar');
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  await saveSetting(KEYS.refreshToken, tokens.refresh_token);
  const channel = await fetchChannel();
  await saveSetting(KEYS.channel, JSON.stringify(channel));
  return channel;
}

let accessCache = null;
async function accessToken() {
  if (accessCache && accessCache.expiresAt > Date.now()) return accessCache.token;
  const row = await prisma.systemSetting.findUnique({ where: { key: KEYS.refreshToken } });
  if (!row?.value) throw new Error('YouTube no está conectado: pulsa "Conectar YouTube"');
  const tokens = await tokenRequest({ refresh_token: row.value, grant_type: 'refresh_token' });
  accessCache = { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 };
  return accessCache.token;
}

async function fetchChannel() {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`YouTube: ${data.error?.message || `HTTP ${res.status}`}`);
  const ch = data.items?.[0];
  if (!ch) throw new Error('La cuenta autorizada no tiene canal de YouTube (si el canal es de una cuenta de marca, elígela al autorizar)');
  return { id: ch.id, title: ch.snippet?.title, handle: ch.snippet?.customUrl || null };
}

export async function connectionStatus() {
  if (!youtubeConfigured()) return { configured: false, connected: false };
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let channel = null;
  try { channel = byKey[KEYS.channel] ? JSON.parse(byKey[KEYS.channel]) : null; } catch { /* sin canal */ }
  return { configured: !!byKey[KEYS.refreshToken], connected: !!byKey[KEYS.refreshToken], channel };
}

export async function disconnect() {
  const row = await prisma.systemSetting.findUnique({ where: { key: KEYS.refreshToken } });
  if (row?.value) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(row.value)}`, { method: 'POST' }).catch(() => {});
  }
  await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
  accessCache = null;
}

/**
 * Sube un Short (subida reanudable en una sola petición).
 * privacyStatus: "private" | "unlisted" | "public". Mientras Google no audite el proyecto, YouTube deja los
 * videos subidos por API en privado aunque se pida "public".
 */
export async function uploadShort({ videoAbsPath, title, description, tags = [], privacyStatus = 'private' }) {
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
  const token = await accessToken();
  const file = await fs.promises.readFile(videoAbsPath);
  const safeTitle = String(title || '').replace(/[<>]/g, '').trim().slice(0, 100);
  const metadata = {
    snippet: {
      title: /#shorts/i.test(safeTitle) || safeTitle.length > 92 ? safeTitle : `${safeTitle} #Shorts`,
      description: String(description || '').replace(/[<>]/g, '').slice(0, 4900),
      tags: tags.slice(0, 15),
      categoryId: '26', // Howto & Style
    },
    status: { privacyStatus, selfDeclaredMadeForKids: false, embeddable: true },
  };

  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/*',
      'X-Upload-Content-Length': String(file.length),
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) {
    const err = await init.json().catch(() => ({}));
    throw new Error(`YouTube no aceptó la subida: ${err.error?.message || `HTTP ${init.status}`}`);
  }
  const uploadUrl = init.headers.get('location');
  const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'video/*', 'Content-Length': String(file.length) }, body: file });
  const video = await put.json().catch(() => ({}));
  if (!put.ok || !video.id) throw new Error(`YouTube falló al recibir el video: ${video.error?.message || `HTTP ${put.status}`}`);
  return { id: video.id, url: `https://youtube.com/shorts/${video.id}`, privacy: video.status?.privacyStatus || privacyStatus };
}

export default { youtubeConfigured, getAuthUrl, handleCallback, connectionStatus, disconnect, uploadShort };
