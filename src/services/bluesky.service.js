// Bluesky: conexión de la cuenta con una contraseña de aplicación (Ajustes → Privacidad y seguridad → Contraseñas de
// aplicación) y publicación de videos con la API de AT Protocol. Se guarda la contraseña de aplicación (nunca la
// contraseña principal: se exige el formato xxxx-xxxx-xxxx-xxxx) y la sesión en SystemSetting.
import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ENTRYWAY = 'https://bsky.social';
const VIDEO_SERVICE = 'https://video.bsky.app';
const PUBLIC_API = 'https://public.api.bsky.app';
const KEYS = { identifier: 'BLUESKY_IDENTIFIER', appPassword: 'BLUESKY_APP_PASSWORD', session: 'BLUESKY_SESSION' };
export const BLUESKY_MAX_TEXT = 300; // grafemas
const APP_PASSWORD_RE = /^[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function xrpc(base, method, { token, query, body, raw, contentType } = {}) {
  const url = new URL(`${base}/xrpc/${method}`);
  if (query) url.search = new URLSearchParams(query).toString();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { payload = raw; headers['Content-Type'] = contentType || 'application/octet-stream'; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, { method: payload ? 'POST' : 'GET', headers, ...(payload && { body: payload }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Bluesky: ${data.message || data.error || `HTTP ${res.status}`}`);
    err.status = res.status;
    err.code = data.error;
    err.data = data;
    throw err;
  }
  return data;
}

async function getSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(KEYS) } } });
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function saveSetting(key, value) {
  await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

// El servidor (PDS) de la cuenta sale del documento DID de la sesión
const pdsOf = (session) => session.didDoc?.service?.find(s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')?.serviceEndpoint || ENTRYWAY;

async function storeSession(s) {
  const session = { did: s.did, handle: s.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt, pds: pdsOf(s) };
  await saveSetting(KEYS.session, JSON.stringify(session));
  return session;
}

async function login(identifier, appPassword) {
  return storeSession(await xrpc(ENTRYWAY, 'com.atproto.server.createSession', { body: { identifier, password: appPassword } }));
}

/** Conecta la cuenta: valida la contraseña de aplicación iniciando sesión y la guarda. */
export async function connect({ identifier, appPassword }) {
  const id = String(identifier || '').trim().replace(/^@/, '');
  const pass = String(appPassword || '').trim();
  if (!id) throw Object.assign(new Error('Falta el usuario de Bluesky (p. ej. stl-gratis.bsky.social)'), { status: 400 });
  if (!APP_PASSWORD_RE.test(pass)) {
    throw Object.assign(new Error('Usa una contraseña de aplicación (formato xxxx-xxxx-xxxx-xxxx), no la contraseña de tu cuenta. Se crea en Bluesky: Ajustes → Privacidad y seguridad → Contraseñas de aplicación'), { status: 400 });
  }
  const session = await login(id, pass);
  await saveSetting(KEYS.identifier, id);
  await saveSetting(KEYS.appPassword, pass);
  return { did: session.did, handle: session.handle };
}

export async function connectionStatus() {
  const s = await getSettings();
  let session = null;
  try { session = s[KEYS.session] ? JSON.parse(s[KEYS.session]) : null; } catch { /* sin sesión */ }
  const connected = !!(s[KEYS.appPassword] && session);
  return { configured: connected, connected, account: connected ? { did: session.did, handle: session.handle } : null };
}

/** Borra la contraseña y la sesión (en Bluesky también se puede revocar la contraseña de aplicación). */
export async function disconnect() {
  await prisma.systemSetting.deleteMany({ where: { key: { in: Object.values(KEYS) } } });
}

/**
 * Ejecuta `fn(session)` con una sesión válida: si el token caducó, la renueva; si la renovación falla,
 * vuelve a iniciar sesión con la contraseña de aplicación guardada.
 */
async function withSession(fn) {
  const s = await getSettings();
  if (!s[KEYS.appPassword]) throw new Error('Bluesky no está conectado: pulsa "Conectar Bluesky"');
  let session = null;
  try { session = s[KEYS.session] ? JSON.parse(s[KEYS.session]) : null; } catch { /* se vuelve a iniciar sesión */ }
  if (!session) session = await login(s[KEYS.identifier], s[KEYS.appPassword]);
  try {
    return await fn(session);
  } catch (e) {
    if (!(e.status === 400 || e.status === 401) || !/expired|invalid ?token|authentication/i.test(`${e.code} ${e.message}`)) throw e;
    try {
      session = await storeSession(await xrpc(session.pds, 'com.atproto.server.refreshSession', { token: session.refreshJwt, body: {} }));
    } catch {
      session = await login(s[KEYS.identifier], s[KEYS.appPassword]);
    }
    return fn(session);
  }
}

// ---------- Texto ----------
const segmenter = new Intl.Segmenter('es', { granularity: 'grapheme' });
const graphemes = (text) => [...segmenter.segment(String(text || ''))].map(s => s.segment);

/** Texto del post: el cuerpo del caption recortado a 300 grafemas + el link al final (clicable con un facet). */
export function blueskyText(body, link) {
  const tail = link ? `\n\n🔗 ${link}` : '';
  const room = BLUESKY_MAX_TEXT - graphemes(tail).length;
  const parts = graphemes(String(body || '').trim());
  const text = parts.length > room ? `${parts.slice(0, room - 1).join('').trimEnd()}…` : parts.join('');
  return `${text}${tail}`;
}

/** Facets (enlaces y hashtags clicables): Bluesky los pide con posiciones en bytes UTF-8. */
export function buildFacets(text) {
  const facets = [];
  const byteIndex = (i) => Buffer.byteLength(text.slice(0, i), 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s]+/g)) {
    const uri = m[0].replace(/[.,;:!?)]+$/, '');
    facets.push({ index: { byteStart: byteIndex(m.index), byteEnd: byteIndex(m.index + uri.length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]+)/gu)) {
    const start = m.index + m[1].length;
    const tag = m[2];
    if (/^\d+$/.test(tag)) continue;
    facets.push({ index: { byteStart: byteIndex(start), byteEnd: byteIndex(start + 1 + tag.length) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag }] });
  }
  return facets;
}

// ---------- Video ----------
/** Sube el video al servicio de video de Bluesky y espera a que lo procese; devuelve el blob para el post. */
async function uploadVideo(session, videoAbsPath) {
  const bytes = await fs.promises.readFile(videoAbsPath);
  if (bytes.length > 100 * 1024 * 1024) throw new Error('Bluesky: el video pesa más de 100 MB');
  const pdsHost = new URL(session.pds).host;
  const { token } = await xrpc(session.pds, 'com.atproto.server.getServiceAuth', {
    token: session.accessJwt,
    query: { aud: `did:web:${pdsHost}`, lxm: 'com.atproto.repo.uploadBlob', exp: String(Math.floor(Date.now() / 1000) + 30 * 60) },
  });

  let job;
  try {
    job = await xrpc(VIDEO_SERVICE, 'app.bsky.video.uploadVideo', {
      token, query: { did: session.did, name: `${Date.now()}-${path.basename(videoAbsPath)}` }, raw: bytes, contentType: 'video/mp4',
    });
  } catch (e) {
    // El mismo video ya subido: se reutiliza su trabajo
    if (e.data?.jobId) job = e.data;
    else throw e;
  }
  let status = job.jobStatus || job;
  for (let i = 0; i < 90 && !status.blob; i++) {
    if (status.state === 'JOB_STATE_FAILED') throw new Error(`Bluesky no procesó el video: ${status.error || status.message || 'error desconocido'}`);
    await sleep(4000);
    status = (await xrpc(VIDEO_SERVICE, 'app.bsky.video.getJobStatus', { query: { jobId: status.jobId || job.jobId } })).jobStatus;
  }
  if (!status.blob) throw new Error('Bluesky sigue procesando el video tras 6 minutos: revisa tu perfil antes de reintentar');
  return status.blob;
}

/** Publica un video con su texto. Devuelve { id (uri del post), url, cid }. */
export async function publishVideo({ videoAbsPath, text, alt = '', aspectRatio = { width: 1080, height: 1920 } }) {
  return withSession(async (session) => {
    const blob = await uploadVideo(session, videoAbsPath);
    const finalText = String(text || '');
    const record = {
      $type: 'app.bsky.feed.post',
      text: finalText,
      createdAt: new Date().toISOString(),
      langs: ['es', 'en'],
      facets: buildFacets(finalText),
      embed: { $type: 'app.bsky.embed.video', video: blob, aspectRatio, ...(alt && { alt: String(alt).slice(0, 1000) }) },
    };
    const res = await xrpc(session.pds, 'com.atproto.repo.createRecord', {
      token: session.accessJwt, body: { repo: session.did, collection: 'app.bsky.feed.post', record },
    });
    const rkey = res.uri.split('/').pop();
    return { id: res.uri, cid: res.cid, url: `https://bsky.app/profile/${session.handle}/post/${rkey}` };
  });
}

/** Métricas públicas de varios posts (Bluesky no da vistas: me gusta, respuestas, reposts, citas y guardados). */
export async function postsMetrics(uris) {
  const out = {};
  for (let i = 0; i < uris.length; i += 25) {
    const chunk = uris.slice(i, i + 25);
    const url = new URL(`${PUBLIC_API}/xrpc/app.bsky.feed.getPosts`);
    chunk.forEach(u => url.searchParams.append('uris', u));
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Bluesky: ${data.message || `HTTP ${res.status}`}`);
    for (const p of data.posts || []) {
      out[p.uri] = { views: null, likes: p.likeCount ?? 0, comments: p.replyCount ?? 0, shares: (p.repostCount ?? 0) + (p.quoteCount ?? 0), saves: p.bookmarkCount ?? null };
    }
  }
  return out;
}

export default { connect, connectionStatus, disconnect, publishVideo, blueskyText, buildFacets, postsMetrics };
