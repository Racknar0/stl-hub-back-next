// YouTube Shorts: conexión de uno o varios canales (OAuth de Google) y subida de videos con la YouTube Data API v3.
// Los canales conectados (con su refresh token) se guardan en SystemSetting; el client id/secret vienen del .env.
import crypto from 'crypto';
import fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ACCOUNTS_KEY = 'YOUTUBE_ACCOUNTS';
// Formato antiguo (un solo canal): se migra a la lista al leerla
const LEGACY = { refreshToken: 'YOUTUBE_REFRESH_TOKEN', channel: 'YOUTUBE_CHANNEL' };
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
    prompt: 'consent select_account', // fuerza el refresh token y deja elegir el canal (cuenta de marca)
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

/** Canales conectados: [{ id, title, handle, refreshToken }] (el primero es el canal principal). */
async function loadAccounts() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: [ACCOUNTS_KEY, ...Object.values(LEGACY)] } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  let accounts = [];
  try { accounts = byKey[ACCOUNTS_KEY] ? JSON.parse(byKey[ACCOUNTS_KEY]) : []; } catch { accounts = []; }
  if (!accounts.length && byKey[LEGACY.refreshToken]) {
    let channel = {};
    try { channel = JSON.parse(byKey[LEGACY.channel] || '{}'); } catch { /* sin datos del canal */ }
    accounts = [{ id: channel.id, title: channel.title, handle: channel.handle || null, refreshToken: byKey[LEGACY.refreshToken] }];
    await saveAccounts(accounts);
    await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(LEGACY) } } });
  }
  return accounts;
}

async function saveAccounts(accounts) {
  await saveSetting(ACCOUNTS_KEY, JSON.stringify(accounts));
}

const publicChannel = (a) => ({ id: a.id, title: a.title, handle: a.handle || null });

/** Canales conectados sin el token (para la interfaz y para elegir canales). */
export async function listChannels() {
  return (await loadAccounts()).map(publicChannel);
}

/** Intercambia el código del callback y añade (o actualiza) el canal elegido en la lista. */
export async function handleCallback({ code, state }) {
  const expires = pendingStates.get(state);
  pendingStates.delete(state);
  if (!expires || expires < Date.now()) throw new Error('La autorización caducó o no es válida: vuelve a pulsar "Conectar YouTube"');
  const tokens = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: process.env.YOUTUBE_REDIRECT_URI });
  if (!tokens.refresh_token) throw new Error('Google no devolvió el refresh token: quita el acceso de la app en tu cuenta de Google y vuelve a conectar');
  const channel = await fetchChannel(tokens.access_token);
  accessCache.set(channel.id, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 });
  const accounts = await loadAccounts();
  const existing = accounts.find(a => a.id === channel.id);
  if (existing) Object.assign(existing, channel, { refreshToken: tokens.refresh_token });
  else accounts.push({ ...channel, refreshToken: tokens.refresh_token });
  await saveAccounts(accounts);
  return channel;
}

// Token de acceso por canal (caducan en ~1 hora)
const accessCache = new Map();
async function accessToken(account) {
  const cached = accessCache.get(account.id);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const tokens = await tokenRequest({ refresh_token: account.refreshToken, grant_type: 'refresh_token' });
  accessCache.set(account.id, { token: tokens.access_token, expiresAt: Date.now() + (tokens.expires_in - 60) * 1000 });
  return tokens.access_token;
}

async function fetchChannel(token) {
  const res = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`YouTube: ${data.error?.message || `HTTP ${res.status}`}`);
  const ch = data.items?.[0];
  if (!ch) throw new Error('La cuenta autorizada no tiene canal de YouTube (si el canal es de una cuenta de marca, elígela al autorizar)');
  return { id: ch.id, title: ch.snippet?.title, handle: ch.snippet?.customUrl || null };
}

export async function connectionStatus() {
  if (!youtubeConfigured()) return { configured: false, connected: false, channels: [] };
  const channels = await listChannels();
  return { configured: channels.length > 0, connected: channels.length > 0, channel: channels[0] || null, channels };
}

/** Desconecta un canal (o todos si no se indica): revoca su token en Google y lo borra. */
export async function disconnect(channelId) {
  const accounts = await loadAccounts();
  const removed = channelId ? accounts.filter(a => a.id === channelId) : accounts;
  for (const a of removed) {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refreshToken)}`, { method: 'POST' }).catch(() => {});
    accessCache.delete(a.id);
  }
  await saveAccounts(accounts.filter(a => !removed.includes(a)));
}

/**
 * Sube un Short a un canal (subida reanudable en una sola petición).
 * privacyStatus: "private" | "unlisted" | "public". Con publishAt (ISO) el video se sube privado y YouTube
 * lo hace público solo a esa hora.
 */
export async function uploadShort({ channelId, videoAbsPath, title, description, tags = [], privacyStatus = 'private', publishAt = null }) {
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
  const accounts = await loadAccounts();
  const account = channelId ? accounts.find(a => a.id === channelId) : accounts[0];
  if (!account) throw new Error(channelId ? 'Ese canal de YouTube ya no está conectado' : 'YouTube no está conectado: pulsa "Conectar YouTube"');
  const token = await accessToken(account);
  const file = await fs.promises.readFile(videoAbsPath);
  const safeTitle = String(title || '').replace(/[<>]/g, '').trim().slice(0, 100);
  const metadata = {
    snippet: {
      title: /#shorts/i.test(safeTitle) || safeTitle.length > 92 ? safeTitle : `${safeTitle} #Shorts`,
      description: String(description || '').replace(/[<>]/g, '').slice(0, 4900),
      tags: tags.slice(0, 15),
      categoryId: '26', // Howto & Style
    },
    status: {
      privacyStatus: publishAt ? 'private' : privacyStatus,
      ...(publishAt && { publishAt }),
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
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
  return {
    id: video.id,
    url: `https://youtube.com/shorts/${video.id}`,
    privacy: publishAt ? 'scheduled' : (video.status?.privacyStatus || privacyStatus),
    ...(publishAt && { publishAt }),
    channelId: account.id,
    channelTitle: account.title,
  };
}

export async function uploadHorizontalVideo({ channelId, videoAbsPath, title, description, tags = [], privacyStatus = 'public', publishAt = null }) {
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
  const accounts = await loadAccounts();
  const account = channelId ? accounts.find(a => a.id === channelId || a.title === channelId) : accounts[0];
  if (!account) throw new Error(channelId ? 'Ese canal de YouTube ya no está conectado' : 'YouTube no está conectado: pulsa "Conectar YouTube"');
  const token = await accessToken(account);
  const file = await fs.promises.readFile(videoAbsPath);
  const safeTitle = String(title || '').replace(/[<>]/g, '').trim().slice(0, 100);
  const metadata = {
    snippet: {
      title: safeTitle,
      description: String(description || '').replace(/[<>]/g, '').slice(0, 4900),
      tags: tags.slice(0, 20),
      categoryId: '26', // Howto & Style
    },
    status: {
      privacyStatus: publishAt ? 'private' : privacyStatus,
      ...(publishAt && { publishAt }),
      selfDeclaredMadeForKids: false,
      embeddable: true,
    },
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
  return {
    id: video.id,
    url: `https://youtube.com/watch?v=${video.id}`,
    privacy: publishAt ? 'scheduled' : (video.status?.privacyStatus || privacyStatus),
    ...(publishAt && { publishAt }),
    channelId: account.id,
    channelTitle: account.title,
  };
}

export default { youtubeConfigured, getAuthUrl, handleCallback, connectionStatus, listChannels, disconnect, uploadShort, uploadHorizontalVideo };
