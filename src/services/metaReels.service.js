import fs from 'fs';

// Publicación real de Reels en Instagram y Facebook (Graph API de Meta).
// Usa el token del usuario del sistema "stlhub-publisher" (META_SYSTEM_USER_TOKEN), la Página (META_PAGE_ID)
// y la cuenta de Instagram vinculada (META_IG_USER_ID). Meta descarga el video desde una URL pública.

const version = () => process.env.META_GRAPH_VERSION || 'v23.0';
const GRAPH = () => `https://graph.facebook.com/${version()}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function metaConfigured() {
  return !!(process.env.META_SYSTEM_USER_TOKEN && process.env.META_PAGE_ID && process.env.META_IG_USER_ID);
}

async function graph(method, path, params = {}, token = process.env.META_SYSTEM_USER_TOKEN) {
  const url = new URL(`${GRAPH()}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new Error(`Meta ${path.split('?')[0]}: ${e.error_user_msg || e.message || `HTTP ${res.status}`}${e.code ? ` (code ${e.code})` : ''}`);
  }
  return data;
}

// El token de cada Página caduca con el del usuario del sistema (nunca): se cachea mientras corre el servidor
const pageTokenCache = new Map();
async function pageToken(pageId) {
  if (!pageTokenCache.has(pageId)) {
    const page = await graph('GET', pageId, { fields: 'access_token' });
    if (!page.access_token) throw new Error('Meta: no se obtuvo el token de la Página (¿está asignada al usuario del sistema?)');
    pageTokenCache.set(pageId, page.access_token);
  }
  return pageTokenCache.get(pageId);
}

// Páginas de Facebook asignadas al usuario del sistema en el portafolio (se cachean 10 min)
let pagesCache = { at: 0, list: [] };
/**
 * Lista las Páginas donde se puede publicar: la principal (META_PAGE_ID) primero y luego las demás
 * que estén asignadas al usuario del sistema "stlhub-publisher" en Meta Business.
 */
export async function listFacebookPages({ fresh = false } = {}) {
  if (!metaConfigured()) return [];
  if (!fresh && Date.now() - pagesCache.at < 10 * 60 * 1000 && pagesCache.list.length) return pagesCache.list;
  const primaryId = String(process.env.META_PAGE_ID);
  let pages = [];
  try {
    const data = await graph('GET', 'me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: '50' });
    pages = (data.data || []).map(p => ({
      id: String(p.id),
      name: p.name,
      // Cuenta de Instagram vinculada a la Página (la "pareja" de Business Suite)
      ...(p.instagram_business_account && { igId: String(p.instagram_business_account.id), igUsername: p.instagram_business_account.username }),
    }));
  } catch (e) {
    console.warn('[REELS][FB] No se pudieron listar las Páginas:', e.message);
  }
  if (!pages.some(p => p.id === primaryId)) pages.unshift({ id: primaryId, name: 'Página principal' });
  pages.sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : a.name.localeCompare(b.name)));
  pagesCache = { at: Date.now(), list: pages };
  return pages;
}

/**
 * Cuentas de Instagram donde se puede publicar: la principal (META_IG_USER_ID) primero y luego las vinculadas
 * a las demás Páginas asignadas al usuario del sistema.
 */
export async function listInstagramAccounts(opts) {
  if (!metaConfigured()) return [];
  const primaryId = String(process.env.META_IG_USER_ID);
  const pages = await listFacebookPages(opts);
  const accounts = pages.filter(p => p.igId).map(p => ({ id: p.igId, username: p.igUsername, pageName: p.name }));
  if (!accounts.some(a => a.id === primaryId)) accounts.unshift({ id: primaryId, username: 'Instagram principal' });
  accounts.sort((a, b) => (a.id === primaryId ? -1 : b.id === primaryId ? 1 : 0));
  return accounts;
}

/** Instagram Reel: contenedor → esperar a que Instagram procese el video → publicar. */
export async function publishInstagramReel({ igUserId, videoUrl, caption }) {
  const igUser = igUserId || process.env.META_IG_USER_ID;
  const container = await graph('POST', `${igUser}/media`, {
    media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: 'true',
  });

  // Instagram procesa el video en sus servidores: se consulta el estado hasta ~5 min
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const { status_code: status, status: detail } = await graph('GET', container.id, { fields: 'status_code,status' });
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram no pudo procesar el video: ${detail || status}`);
    if (i === 59) throw new Error('Instagram tardó demasiado en procesar el video');
  }

  const { id } = await graph('POST', `${igUser}/media_publish`, { creation_id: container.id });
  const { permalink } = await graph('GET', id, { fields: 'permalink' }).catch(() => ({}));
  return { id, url: permalink || null };
}

/** Facebook Reel: iniciar subida → Meta descarga el video de la URL → publicar → primer comentario con el link. */
export async function publishFacebookReel({ pageId = process.env.META_PAGE_ID, videoAbsPath, videoUrl, caption, firstComment, publishAt = null }) {
  const token = await pageToken(pageId);

  const { video_id: videoId } = await graph('POST', `${pageId}/video_reels`, { upload_phase: 'start' }, token);
  // Se sube el archivo directamente: el descargador de Facebook recibe 403 de la web (protección antibots),
  // así que la URL pública solo se usa si el archivo no está en este servidor
  const fileBuffer = videoAbsPath && fs.existsSync(videoAbsPath) ? await fs.promises.readFile(videoAbsPath) : null;
  const upload = await fetch(`https://rupload.facebook.com/video-upload/${version()}/${videoId}`, {
    method: 'POST',
    headers: fileBuffer
      ? { Authorization: `OAuth ${token}`, offset: '0', file_size: String(fileBuffer.length), 'Content-Type': 'application/octet-stream' }
      : { Authorization: `OAuth ${token}`, file_url: videoUrl },
    body: fileBuffer || undefined,
  });
  const uploadData = await upload.json().catch(() => ({}));
  if (!upload.ok || uploadData.error || uploadData.success === false) {
    const reason = uploadData.debug_info?.message || uploadData.error?.message || `HTTP ${upload.status}`;
    throw new Error(`Facebook no pudo recibir el video: ${reason}`);
  }

  // Con publishAt, Facebook lo deja programado y lo publica solo a esa hora
  const scheduled = !!publishAt;
  await graph('POST', `${pageId}/video_reels`, {
    upload_phase: 'finish', video_id: videoId, description: caption,
    ...(scheduled
      ? { video_state: 'SCHEDULED', scheduled_publish_time: String(Math.floor(new Date(publishAt).getTime() / 1000)) }
      : { video_state: 'PUBLISHED' }),
  }, token);

  // Esperar a que el reel quede publicado, o procesado si está programado (hasta ~5 min)
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const { status } = await graph('GET', videoId, { fields: 'status' }, token);
    if (status?.video_status === 'error' || status?.processing_phase?.status === 'error' || status?.publishing_phase?.status === 'error') {
      throw new Error(`Facebook no pudo procesar el video: ${JSON.stringify(status?.processing_phase?.errors || status?.publishing_phase?.errors || status)}`);
    }
    if (status?.publishing_phase?.status === 'complete') break;
    if (scheduled && status?.processing_phase?.status === 'complete') break;
    if (i === 59) throw new Error('Facebook tardó demasiado en publicar el reel');
  }

  const { permalink_url: permalink } = await graph('GET', videoId, { fields: 'permalink_url' }, token).catch(() => ({}));
  let commentId = null;
  let commentError = null;
  // Un reel programado aún no admite comentarios: en ese caso el link ya va dentro del texto
  if (firstComment && !scheduled) {
    // Si el comentario falla, el reel ya está publicado: se registra (y se avisa) pero no se marca como error
    try {
      commentId = (await graph('POST', `${videoId}/comments`, { message: firstComment }, token)).id;
    } catch (e) {
      commentError = e.message;
      console.warn('[REELS][FB] No se pudo publicar el primer comentario:', e.message);
    }
  }
  return {
    id: videoId,
    url: permalink ? (permalink.startsWith('http') ? permalink : `https://www.facebook.com${permalink}`) : null,
    commentId,
    ...(scheduled && { privacy: 'scheduled', publishAt }),
    ...(commentError && { commentError }),
  };
}

/**
 * Video normal (horizontal 16:9) en el feed de una Página: se sube el archivo → se espera a que Facebook lo procese
 * → primer comentario con el link. A diferencia de video_reels, admite videos largos y horizontales.
 */
export async function publishFacebookVideo({ pageId = process.env.META_PAGE_ID, videoAbsPath, title, description, firstComment }) {
  const token = await pageToken(pageId);
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
  const form = new FormData();
  form.append('access_token', token);
  form.append('title', String(title || '').slice(0, 250));
  form.append('description', description || '');
  form.append('published', 'true');
  form.append('source', new Blob([await fs.promises.readFile(videoAbsPath)], { type: 'video/mp4' }), 'video.mp4');
  const res = await fetch(`https://graph-video.facebook.com/${version()}/${pageId}/videos`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.id) {
    const e = data.error || {};
    throw new Error(`Facebook no pudo recibir el video: ${e.error_user_msg || e.message || `HTTP ${res.status}`}`);
  }
  const videoId = String(data.id);

  // Esperar a que Facebook termine de procesarlo (hasta ~5 min) antes de comentar
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const { status } = await graph('GET', videoId, { fields: 'status' }, token).catch(() => ({}));
    if (status?.video_status === 'error' || status?.processing_phase?.status === 'error') {
      throw new Error(`Facebook no pudo procesar el video: ${JSON.stringify(status?.processing_phase?.errors || status)}`);
    }
    if (status?.video_status === 'ready' || status?.publishing_phase?.status === 'complete') break;
  }

  const { permalink_url: permalink } = await graph('GET', videoId, { fields: 'permalink_url' }, token).catch(() => ({}));
  let commentId = null;
  let commentError = null;
  if (firstComment) {
    // Si el comentario falla, el video ya está publicado: se registra pero no se marca como error
    try {
      commentId = (await graph('POST', `${videoId}/comments`, { message: firstComment }, token)).id;
    } catch (e) {
      commentError = e.message;
      console.warn('[HORIZONTAL][FB] No se pudo publicar el primer comentario:', e.message);
    }
  }
  return {
    id: videoId,
    url: permalink ? (permalink.startsWith('http') ? permalink : `https://www.facebook.com${permalink}`) : null,
    commentId,
    ...(commentError && { commentError }),
  };
}

/**
 * Pone el primer comentario en un reel programado una vez que Facebook ya lo publicó.
 * Devuelve { published: false } si todavía no ha salido, o { published: true, commentId }.
 */
export async function commentOnPublishedReel({ pageId, videoId, message }) {
  const token = await pageToken(pageId);
  const { status } = await graph('GET', videoId, { fields: 'status' }, token);
  if (status?.publishing_phase?.status !== 'complete') return { published: false };
  const { id } = await graph('POST', `${videoId}/comments`, { message }, token);
  return { published: true, commentId: id };
}

// --- Métricas (necesitan los permisos read_insights e instagram_manage_insights en el token) ---

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Métricas de un Reel de Facebook: reproducciones, tiempo visto, reacciones, comentarios y compartidos. */
export async function facebookReelMetrics({ pageId, videoId }) {
  if (!pageId) throw new Error('No se sabe en qué Página de Facebook se publicó');
  const token = await pageToken(pageId);
  const [fields, insights] = await Promise.all([
    graph('GET', videoId, { fields: 'likes.summary(true).limit(0),comments.summary(true).limit(0)' }, token),
    graph('GET', `${videoId}/video_insights`, { metric: 'fb_reels_total_plays,post_video_view_time,post_video_avg_time_watched,post_video_social_actions' }, token).catch(() => ({ data: [] })),
  ]);
  const m = Object.fromEntries((insights.data || []).map(x => [x.name, x.values?.[0]?.value]));
  return {
    views: num(m.fb_reels_total_plays),
    likes: num(fields.likes?.summary?.total_count),
    comments: num(fields.comments?.summary?.total_count),
    shares: num(m.post_video_social_actions?.SHARE ?? 0),
    avgWatchSec: m.post_video_avg_time_watched != null ? Math.round(m.post_video_avg_time_watched / 100) / 10 : null,
    totalWatchSec: m.post_video_view_time != null ? Math.round(m.post_video_view_time / 1000) : null,
  };
}

/** Métricas de un Reel de Instagram: reproducciones, alcance, me gusta, comentarios, compartidos, guardados y tiempo visto. */
export async function instagramMediaMetrics({ mediaId }) {
  const data = await graph('GET', `${mediaId}/insights`, { metric: 'views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time,ig_reels_video_view_total_time' });
  const m = Object.fromEntries((data.data || []).map(x => [x.name, x.values?.[0]?.value]));
  return {
    views: num(m.views),
    reach: num(m.reach),
    likes: num(m.likes),
    comments: num(m.comments),
    shares: num(m.shares),
    saves: num(m.saved),
    avgWatchSec: m.ig_reels_avg_watch_time != null ? Math.round(m.ig_reels_avg_watch_time / 100) / 10 : null,
    totalWatchSec: m.ig_reels_video_view_total_time != null ? Math.round(m.ig_reels_video_view_total_time / 1000) : null,
  };
}

export default { metaConfigured, listFacebookPages, listInstagramAccounts, publishInstagramReel, publishFacebookReel, publishFacebookVideo, commentOnPublishedReel, facebookReelMetrics, instagramMediaMetrics };
