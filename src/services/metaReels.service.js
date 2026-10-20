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

// El token de la Página caduca con el del usuario del sistema (nunca): se cachea mientras corre el servidor
let pageTokenCache = null;
async function pageToken() {
  if (!pageTokenCache) {
    const page = await graph('GET', process.env.META_PAGE_ID, { fields: 'access_token' });
    if (!page.access_token) throw new Error('Meta: no se obtuvo el token de la Página (¿está asignada al usuario del sistema?)');
    pageTokenCache = page.access_token;
  }
  return pageTokenCache;
}

/** Instagram Reel: contenedor → esperar a que Instagram procese el video → publicar. */
export async function publishInstagramReel({ videoUrl, caption }) {
  const igUser = process.env.META_IG_USER_ID;
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
export async function publishFacebookReel({ videoUrl, caption, firstComment }) {
  const pageId = process.env.META_PAGE_ID;
  const token = await pageToken();

  const { video_id: videoId } = await graph('POST', `${pageId}/video_reels`, { upload_phase: 'start' }, token);
  const upload = await fetch(`https://rupload.facebook.com/video-upload/${version()}/${videoId}`, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, file_url: videoUrl },
  });
  const uploadData = await upload.json().catch(() => ({}));
  if (!upload.ok || uploadData.error) throw new Error(`Facebook no pudo descargar el video: ${uploadData.error?.message || `HTTP ${upload.status}`}`);

  await graph('POST', `${pageId}/video_reels`, {
    upload_phase: 'finish', video_id: videoId, video_state: 'PUBLISHED', description: caption,
  }, token);

  // Esperar a que el reel quede publicado (hasta ~5 min)
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const { status } = await graph('GET', videoId, { fields: 'status' }, token);
    if (status?.video_status === 'error' || status?.processing_phase?.status === 'error') {
      throw new Error(`Facebook no pudo procesar el video: ${JSON.stringify(status?.processing_phase?.errors || status)}`);
    }
    if (status?.publishing_phase?.status === 'complete') break;
    if (i === 59) throw new Error('Facebook tardó demasiado en publicar el reel');
  }

  const { permalink_url: permalink } = await graph('GET', videoId, { fields: 'permalink_url' }, token).catch(() => ({}));
  let commentId = null;
  if (firstComment) {
    // Si el comentario falla, el reel ya está publicado: se registra pero no se marca como error
    commentId = await graph('POST', `${videoId}/comments`, { message: firstComment }, token)
      .then(r => r.id)
      .catch(e => { console.warn('[REELS][FB] No se pudo publicar el primer comentario:', e.message); return null; });
  }
  return { id: videoId, url: permalink ? (permalink.startsWith('http') ? permalink : `https://www.facebook.com${permalink}`) : null, commentId };
}

export default { metaConfigured, publishInstagramReel, publishFacebookReel };
