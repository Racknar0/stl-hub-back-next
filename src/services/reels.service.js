import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { generateReelTexts, mockReelTexts, isMockAi, captionBody } from './reelsAi.service.js';
import { metaConfigured, publishInstagramReel, publishFacebookReel } from './metaReels.service.js';
import { dispatchReelNotification } from '../utils/reelsNotifications.js';
import { uploadShort, connectionStatus as youtubeStatus } from './youtube.service.js';
import { publishVideo as publishTiktokVideo, tiktokOptionsProblem } from './tiktok.service.js';

const prisma = new PrismaClient();

export const PLATFORMS = ['instagram', 'facebook', 'youtube', 'tiktok'];
const SETTINGS = { defaultTime: 'REELS_DEFAULT_TIME', timeSpread: 'REELS_TIME_SPREAD', language: 'REELS_LANGUAGE', youtubePrivacy: 'REELS_YOUTUBE_PRIVACY' };
const DEFAULTS = { defaultTime: '18:00', timeSpread: 60, language: 'es', youtubePrivacy: 'private' };
const YOUTUBE_PRIVACY = ['private', 'unlisted', 'public'];
export const SPREAD_OPTIONS = [0, 30, 60, 90, 120];

export const toAbsVideoPath = (videoPath) => path.join(path.resolve('uploads'), String(videoPath || '').replace(/^\/+/, ''));
export const assetLink = (asset, lang = 'es') => (asset ? `https://stlgratis.com/${lang === 'en' ? 'en' : 'es'}/asset/${asset.slug || asset.id}` : null);

// Link con UTM por red y reel, para medir qué trae tráfico
export function platformLink(link, platform, postId) {
  if (!link) return null;
  const url = new URL(link);
  url.searchParams.set('utm_source', platform);
  url.searchParams.set('utm_medium', 'reel');
  url.searchParams.set('utm_campaign', `reel_${postId}`);
  return url.toString();
}

// ---------- Ajustes ----------
export async function getSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: Object.values(SETTINGS) } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    defaultTime: /^\d{2}:\d{2}$/.test(byKey[SETTINGS.defaultTime] || '') ? byKey[SETTINGS.defaultTime] : DEFAULTS.defaultTime,
    timeSpread: SPREAD_OPTIONS.includes(Number(byKey[SETTINGS.timeSpread])) ? Number(byKey[SETTINGS.timeSpread]) : DEFAULTS.timeSpread,
    youtubePrivacy: YOUTUBE_PRIVACY.includes(byKey[SETTINGS.youtubePrivacy]) ? byKey[SETTINGS.youtubePrivacy] : DEFAULTS.youtubePrivacy,
    language: ['es', 'en'].includes(byKey[SETTINGS.language]) ? byKey[SETTINGS.language] : DEFAULTS.language,
  };
}

export async function saveSettings({ defaultTime, timeSpread, language, youtubePrivacy }) {
  const updates = [];
  if (defaultTime !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(defaultTime)) throw new Error('Hora inválida (usa HH:MM)');
    updates.push([SETTINGS.defaultTime, defaultTime, 'Hora por defecto de publicación de los reels']);
  }
  if (timeSpread !== undefined) {
    if (!SPREAD_OPTIONS.includes(Number(timeSpread))) throw new Error('Margen inválido');
    updates.push([SETTINGS.timeSpread, String(Number(timeSpread)), 'Margen aleatorio (± minutos) alrededor de la hora por defecto']);
  }
  if (youtubePrivacy !== undefined) {
    if (!YOUTUBE_PRIVACY.includes(youtubePrivacy)) throw new Error('Privacidad de YouTube inválida');
    updates.push([SETTINGS.youtubePrivacy, youtubePrivacy, 'Privacidad con la que se suben los Shorts: private, unlisted o public']);
  }
  if (language !== undefined) {
    if (!['es', 'en'].includes(language)) throw new Error('Idioma inválido');
    updates.push([SETTINGS.language, language, 'Idioma de los textos de los reels']);
  }
  for (const [key, value, description] of updates) {
    await prisma.systemSetting.upsert({ where: { key }, update: { value }, create: { key, value, description } });
  }
  return getSettings();
}

// ---------- Fechas (hora local del servidor) ----------
export function dayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function atDayTime(dayStr, time) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/**
 * Hora alrededor de la hora por defecto con un desfase aleatorio de ±spread minutos,
 * para que los reels no salgan siempre a la misma hora exacta (parecería un bot).
 */
export function humanTime(defaultTime, spread) {
  const [hh, mm] = defaultTime.split(':').map(Number);
  let minutes = hh * 60 + mm;
  if (spread > 0) {
    minutes += Math.round((Math.random() * 2 - 1) * spread);
    // Evitar horas "redondas" (:00, :30), que delatan la programación automática
    if (minutes % 30 === 0) minutes += Math.random() < 0.5 ? -(3 + Math.floor(Math.random() * 9)) : 3 + Math.floor(Math.random() * 9);
  }
  minutes = Math.min(Math.max(minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// Si la hora ya pasó (p. ej. al soltar un reel en el día de hoy), se programa para dentro de 20-45 min
function notInThePast(date) {
  const now = Date.now();
  if (date.getTime() > now + 10 * 60000) return date;
  return new Date(now + (20 + Math.floor(Math.random() * 25)) * 60000);
}

const timeOf = (date) => {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---------- Asset ----------
const IMAGE_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// Si la imagen no está en este servidor (p. ej. en local), se descarga de la web pública
const PUBLIC_UPLOADS_BASE = process.env.REELS_PUBLIC_UPLOADS_BASE || 'https://stlgratis.com/uploads';

/** Primeras imágenes del asset como partes inline para Gemini. */
export async function loadAssetImageParts(asset, limit = 3) {
  const images = (Array.isArray(asset?.images) ? asset.images : [])
    .map(img => (typeof img === 'string' ? img : img?.path || img?.src || img?.url || ''))
    .map(img => String(img).replace(/\\/g, '/').replace(/^.*\/uploads\//, '').replace(/^\/+/, ''))
    .filter(rel => rel && !rel.includes('..') && IMAGE_MIME[path.extname(rel).toLowerCase()])
    .slice(0, limit);

  const parts = [];
  for (const rel of images) {
    const mimeType = IMAGE_MIME[path.extname(rel).toLowerCase()];
    try {
      const local = path.join(path.resolve('uploads'), rel);
      let buffer;
      if (fs.existsSync(local)) buffer = await fs.promises.readFile(local);
      else {
        const res = await fetch(`${PUBLIC_UPLOADS_BASE}/${rel.split('/').map(encodeURIComponent).join('/')}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        buffer = Buffer.from(await res.arrayBuffer());
      }
      parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
    } catch (e) {
      console.warn(`[REELS][AI] No se pudo cargar la imagen ${rel}: ${e.message}`);
    }
  }
  return parts;
}

// ---------- IA ----------
/** Genera los textos de un reel y, si no tiene asset, intenta encontrarlo en el catálogo. */
export async function processReelAi(postId, { notes, language } = {}) {
  const post = await prisma.reelPost.findUnique({ where: { id: postId } });
  if (!post) return null;
  await prisma.reelPost.update({ where: { id: postId }, data: { aiStatus: 'PROCESSING', aiError: null } });
  try {
    // El idioma lo manda el ajuste actual (no el que tenía el reel al subirse)
    const lang = language || (await getSettings()).language;
    const asset = post.assetId
      ? await prisma.asset.findUnique({ where: { id: post.assetId }, include: { tags: true, categories: true } })
      : null;
    if (!asset && !isMockAi()) {
      throw new Error('El reel no tiene asset: el nombre del video debe empezar por el ID del asset (p. ej. "11848 squall.mp4") o ponlo a mano en el editor');
    }
    const texts = isMockAi()
      ? await mockReelTexts({ asset, notes, language: lang, originalName: post.originalName })
      : await generateWithoutRepeats(post, asset, { notes, language: lang });

    return await prisma.reelPost.update({
      where: { id: postId },
      data: {
        subject: texts.subject || null,
        caption: texts.instagramCaption || null,
        facebookCaption: texts.facebookCaption || null,
        // TikTok usa el mismo texto que Instagram (el link también va en la bio)
        tiktokCaption: texts.instagramCaption || null,
        hashtags: texts.hashtags,
        title: texts.youtubeTitle || null,
        youtubeDescription: texts.youtubeDescription || null,
        language: lang,
        aiGenerated: true,
        aiStatus: 'READY',
        ...(asset && { assetId: asset.id, assetTitle: asset.titleEn || asset.title, link: assetLink(asset, lang) }),
      },
    });
  } catch (e) {
    console.error(`[REELS][AI] Reel ${postId}:`, e.message);
    return prisma.reelPost.update({ where: { id: postId }, data: { aiStatus: 'ERROR', aiError: e.message } });
  }
}

// Los STL son de pago: la descripción no puede prometer nada gratis (el dominio "stlgratis" sí aparece)
const PROMISES_FREE = /\b(gratis|gratuit[oa]s?|free)\b/i;

/** Llama a la IA pasándole las descripciones recientes para que no se repita, y la rechaza si promete "gratis". */
async function generateWithoutRepeats(post, asset, { notes, language }) {
  const recent = await prisma.reelPost.findMany({
    where: { id: { not: post.id }, aiGenerated: true, caption: { not: null } },
    orderBy: { updatedAt: 'desc' },
    take: 15,
    select: { caption: true },
  });
  const recentBodies = recent.map(r => captionBody(r.caption)).filter(Boolean);
  const imageParts = await loadAssetImageParts(asset);
  let texts;
  for (let attempt = 1; attempt <= 2; attempt++) {
    texts = await generateReelTexts({ asset, imageParts, notes, language, recentBodies });
    const bodies = [captionBody(texts.instagramCaption), captionBody(texts.facebookCaption)].join(' ');
    if (!PROMISES_FREE.test(bodies)) return texts;
    console.warn(`[REELS][AI] Reel ${post.id}: la descripción decía "gratis", se regenera (intento ${attempt})`);
  }
  throw new Error('El texto insistía en decir "gratis"; vuelve a revisar o escríbelo a mano');
}

// Cola sencilla: procesa los reels de uno en uno para no saturar la API de Gemini
const aiQueue = [];
let aiRunning = false;
export function enqueueAi(ids) {
  aiQueue.push(...ids);
  if (aiRunning) return;
  aiRunning = true;
  (async () => {
    while (aiQueue.length) await processReelAi(aiQueue.shift());
    aiRunning = false;
  })();
}

// ---------- Validación para publicar ----------
export function missingFields(post) {
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  const missing = [];
  if (!platforms.length) missing.push('plataforma');
  if (platforms.includes('instagram') && !post.caption?.trim()) missing.push('caption de Instagram');
  if (platforms.includes('facebook') && !(post.facebookCaption || post.caption)?.trim()) missing.push('caption de Facebook');
  if (platforms.includes('youtube') && !post.title?.trim()) missing.push('título de YouTube');
  if (platforms.includes('tiktok')) {
    if (!(post.tiktokCaption || post.caption)?.trim()) missing.push('texto de TikTok');
    const problem = tiktokOptionsProblem(post.tiktokOptions);
    if (problem) missing.push(problem);
  }
  return missing;
}

// ---------- Publicación ----------
const hashtagLine = (post) => (Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags.map(h => `#${h}`).join(' ') : '');
const withHashtags = (text, post) => [String(text || '').trim(), hashtagLine(post)].filter(Boolean).join('\n\n');
const publicVideoUrl = (videoPath) => `${PUBLIC_UPLOADS_BASE}/${String(videoPath).split('/').map(encodeURIComponent).join('/')}`;

const PLATFORM_NAMES = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok' };

// Reels que se están subiendo ahora mismo (evita publicar dos veces el mismo si coinciden el worker y "Publicar ahora")
const inFlight = new Set();

async function publishToPlatform(platform, post) {
  const link = platformLink(post.link, platform, post.id);
  if (platform === 'instagram') {
    return publishInstagramReel({ videoUrl: publicVideoUrl(post.videoPath), caption: withHashtags(post.caption, post) });
  }
  if (platform === 'facebook') {
    return publishFacebookReel({ videoAbsPath: toAbsVideoPath(post.videoPath), videoUrl: publicVideoUrl(post.videoPath), caption: withHashtags(post.facebookCaption || post.caption, post), firstComment: link ? `🔗 ${link}` : null });
  }
  if (platform === 'youtube') {
    const { youtubePrivacy } = await getSettings();
    const description = [String(post.youtubeDescription || '').trim(), link].filter(Boolean).join(' ');
    return uploadShort({ videoAbsPath: toAbsVideoPath(post.videoPath), title: post.title, description, tags: Array.isArray(post.hashtags) ? post.hashtags : [], privacyStatus: youtubePrivacy });
  }
  if (platform === 'tiktok') {
    return publishTiktokVideo({ videoAbsPath: toAbsVideoPath(post.videoPath), caption: withHashtags(post.tiktokCaption || post.caption, post), options: post.tiktokOptions });
  }
  throw new Error(`${platform}: publicación no disponible todavía`);
}

/**
 * Publica un reel en sus redes (Instagram, Facebook, YouTube y TikTok). Si una red falla, el reel queda en error
 * y al reintentar solo se vuelven a intentar las redes que fallaron.
 */
export async function publishReel(post) {
  if (inFlight.has(post.id)) throw Object.assign(new Error('Este reel ya se está publicando'), { status: 409 });
  inFlight.add(post.id);
  try {
    const platforms = Array.isArray(post.platforms) ? post.platforms : [];

    if (platforms.some(p => p === 'instagram' || p === 'facebook') && !metaConfigured()) {
      throw new Error('Faltan las credenciales de Meta (META_SYSTEM_USER_TOKEN, META_PAGE_ID, META_IG_USER_ID)');
    }
    await prisma.reelPost.update({ where: { id: post.id }, data: { publishing: true, errorMessage: null } });

    // Las redes ya publicadas de verdad en un intento anterior no se repiten
    const results = { ...(post.results && typeof post.results === 'object' ? post.results : {}) };
    const errors = [];
    for (const p of platforms) {
      if (results[p]?.id && !results[p].simulated) continue;
      try {
        results[p] = { ...(await publishToPlatform(p, post)), publishedAt: new Date().toISOString(), simulated: false };
        console.log(`[REELS] Reel ${post.id} publicado en ${p}: ${results[p].url || results[p].id}`);
      } catch (e) {
        delete results[p];
        errors.push(`${PLATFORM_NAMES[p] || p}: ${e.message}`);
        console.error(`[REELS] Reel ${post.id} falló en ${p}:`, e.message);
      }
    }

    const allDone = platforms.every(p => results[p]?.id && !results[p].simulated);
    const published = platforms.filter(p => results[p]?.id && !results[p].simulated);
    const publishedLinks = published.map(p => ({ label: `Publicado en ${PLATFORM_NAMES[p] || p}`, url: results[p].url }));
    if (errors.length) {
      dispatchReelNotification({
        post,
        title: published.length ? 'Publicado solo en parte' : 'No se pudo publicar',
        detail: `${errors.join('\n')}\n\n${published.length ? `Sí se publicó en: ${published.map(p => PLATFORM_NAMES[p] || p).join(', ')}. ` : ''}Usa "Reintentar publicación": solo se reintentan las redes que fallaron.`,
        links: publishedLinks,
      });
    }
    const fbComment = results.facebook?.commentError;
    if (fbComment && !post.results?.facebook?.commentError) {
      dispatchReelNotification({
        post,
        level: 'WARNING',
        title: 'Facebook: reel sin comentario con el link',
        detail: `El reel se publicó, pero no se pudo poner el primer comentario con el link.\n\nError: ${fbComment}\n\nPuedes añadir el comentario a mano en Facebook.`,
        links: [{ label: 'Reel de Facebook', url: results.facebook.url }, { label: 'Link a comentar', url: platformLink(post.link, 'facebook', post.id) }],
      });
    }
    return await prisma.reelPost.update({
      where: { id: post.id },
      data: {
        results, publishing: false, simulated: false, approved: true,
        ...(allDone
          ? { status: 'PUBLISHED', publishedAt: new Date(), errorMessage: null }
          : { status: 'FAILED', errorMessage: errors.join(' | ') }),
      },
    });
  } catch (e) {
    await prisma.reelPost.update({ where: { id: post.id }, data: { publishing: false, status: 'FAILED', errorMessage: e.message } }).catch(() => {});
    if (e.status !== 409) dispatchReelNotification({ post, title: 'No se pudo publicar', detail: e.message });
    throw e;
  } finally {
    inFlight.delete(post.id);
  }
}

/** Lanza la publicación en segundo plano (Instagram puede tardar minutos en procesar el video). */
export function publishInBackground(post) {
  if (inFlight.has(post.id)) throw Object.assign(new Error('Este reel ya se está publicando'), { status: 409 });
  publishReel(post).catch(e => console.error(`[REELS] Reel ${post.id}:`, e.message));
}

/** Publica los reels aprobados cuya hora ya llegó. */
export async function publishDueReels() {
  const due = await prisma.reelPost.findMany({
    where: { status: 'PENDING', approved: true, publishing: false, scheduledAt: { lte: new Date() } },
    orderBy: { scheduledAt: 'asc' },
  });
  for (const post of due) {
    if (inFlight.has(post.id)) continue;
    const missing = missingFields(post);
    if (missing.length) {
      await prisma.reelPost.update({ where: { id: post.id }, data: { status: 'FAILED', errorMessage: `Falta: ${missing.join(', ')}` } });
      dispatchReelNotification({ post, title: 'No se publicó: faltan textos', detail: `Llegó su hora pero le falta: ${missing.join(', ')}.\n\nCompleta los textos y pulsa "Reintentar publicación".` });
      continue;
    }
    await publishReel(post).catch(e => console.error(`[REELS] Reel ${post.id}:`, e.message));
  }

  // Reels que llegaron a su hora sin aprobar: se avisa una vez por fecha (si se reprograma, vuelve a avisar)
  const overdue = await prisma.reelPost.findMany({
    where: { status: 'PENDING', approved: false, publishing: false, scheduledAt: { lte: new Date() } },
  });
  for (const post of overdue) {
    if (post.overdueNotifiedAt && post.overdueNotifiedAt >= post.scheduledAt) continue;
    await prisma.reelPost.update({ where: { id: post.id }, data: { overdueNotifiedAt: new Date() } });
    dispatchReelNotification({
      post,
      level: 'WARNING',
      title: 'Reel sin aprobar a su hora',
      detail: 'Llegó la hora de publicación pero el reel no estaba aprobado, así que no se publicó.\n\nApruébalo (se publicará en el siguiente minuto) o muévelo a otro día.',
    });
  }
}

let workerTimer = null;
export function startReelsWorker(intervalMs = 60000) {
  if (workerTimer) return;
  // Si el servidor se reinició a mitad de una subida, el reel queda en error para revisarlo (no se re-publica solo)
  const interruptedMsg = 'El servidor se reinició durante la publicación: revisa las redes antes de reintentar';
  prisma.reelPost.findMany({ where: { publishing: true } })
    .then(async (interrupted) => {
      for (const post of interrupted) {
        await prisma.reelPost.update({ where: { id: post.id }, data: { publishing: false, status: 'FAILED', errorMessage: interruptedMsg } });
        dispatchReelNotification({ post, title: 'Publicación interrumpida', detail: `${interruptedMsg}. Comprueba en cada red si llegó a publicarse antes de pulsar "Reintentar".` });
      }
    })
    .catch(e => console.error('[REELS] Worker:', e.message));
  workerTimer = setInterval(() => publishDueReels().catch(e => console.error('[REELS] Worker:', e.message)), intervalMs);
}

// ---------- Calendario ----------
/** Mueve un reel a un día (o a la bandeja con day=null). Si el día está ocupado, intercambia los reels. */
export async function assignDay(postId, day) {
  const post = await prisma.reelPost.findUnique({ where: { id: postId } });
  if (!post) throw Object.assign(new Error('Reel no encontrado'), { status: 404 });
  if (post.status === 'PUBLISHED') throw Object.assign(new Error('Un reel publicado no se puede mover'), { status: 400 });

  if (!day) {
    return prisma.reelPost.update({ where: { id: postId }, data: { scheduledAt: null, status: 'PENDING' } });
  }
  if (day < dayKey(new Date())) throw Object.assign(new Error('No se puede programar en un día pasado'), { status: 400 });

  const { defaultTime, timeSpread } = await getSettings();
  // Al moverlo entre días conserva su hora; si viene de la bandeja se le da una hora "humana"
  const time = post.scheduledAt ? timeOf(post.scheduledAt) : humanTime(defaultTime, timeSpread);
  const [y, m, d] = day.split('-').map(Number);
  const occupant = await prisma.reelPost.findFirst({
    where: { id: { not: postId }, scheduledAt: { gte: new Date(y, m - 1, d), lt: new Date(y, m - 1, d + 1) } },
  });
  if (occupant?.status === 'PUBLISHED') throw Object.assign(new Error('Ese día ya tiene un reel publicado'), { status: 400 });

  return prisma.$transaction(async (tx) => {
    if (occupant) {
      // El reel que ocupaba el día pasa al día del que viene (o a la bandeja), conservando su hora
      const swapTo = post.scheduledAt ? atDayTime(dayKey(post.scheduledAt), timeOf(occupant.scheduledAt)) : null;
      await tx.reelPost.update({ where: { id: occupant.id }, data: { scheduledAt: swapTo, status: 'PENDING' } });
    }
    return tx.reelPost.update({ where: { id: postId }, data: { scheduledAt: notInThePast(atDayTime(day, time)), status: 'PENDING' } });
  });
}

/** Coloca los reels de la bandeja, uno por día, en los próximos días libres. */
export async function autoFill() {
  const tray = await prisma.reelPost.findMany({ where: { scheduledAt: null, status: { not: 'PUBLISHED' } }, orderBy: { createdAt: 'asc' } });
  if (!tray.length) return { assigned: 0 };
  const { defaultTime, timeSpread } = await getSettings();
  const now = new Date();
  // Hoy solo cuenta si aún queda margen antes del inicio de la franja (hora por defecto − margen)
  const start = atDayTime(dayKey(now), defaultTime).getTime() - timeSpread * 60000 > now.getTime() + 15 * 60000 ? 0 : 1;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + start);
  const taken = new Set((await prisma.reelPost.findMany({
    where: { scheduledAt: { gte: from } }, select: { scheduledAt: true },
  })).map(p => dayKey(p.scheduledAt)));

  let assigned = 0;
  for (let offset = 0; assigned < tray.length && offset < 366; offset++) {
    const day = dayKey(new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset));
    if (taken.has(day)) continue;
    // Cada día a una hora distinta dentro de la franja, para que no parezca un bot
    await prisma.reelPost.update({ where: { id: tray[assigned].id }, data: { scheduledAt: atDayTime(day, humanTime(defaultTime, timeSpread)) } });
    taken.add(day);
    assigned++;
  }
  return { assigned };
}

/** Redes por defecto de un reel nuevo: YouTube si el canal está conectado; TikTok nunca (se marca a mano en cada reel). */
export async function defaultPlatforms() {
  const yt = await youtubeStatus().catch(() => ({ connected: false }));
  return PLATFORMS.filter(p => p !== 'tiktok' && (p !== 'youtube' || yt.connected));
}

export async function deleteReel(postId) {
  const existing = await prisma.reelPost.findUnique({ where: { id: postId } });
  if (!existing) throw Object.assign(new Error('Reel no encontrado'), { status: 404 });
  if (existing.publishing || inFlight.has(postId)) throw Object.assign(new Error('El reel se está publicando ahora mismo'), { status: 409 });
  await prisma.reelPost.delete({ where: { id: postId } });
  const stillUsed = await prisma.reelPost.count({ where: { videoPath: existing.videoPath } });
  if (!stillUsed) await fs.promises.rm(toAbsVideoPath(existing.videoPath), { force: true });
}

export default {
  getSettings, saveSettings, processReelAi, enqueueAi, missingFields, publishReel, publishInBackground, publishDueReels,
  startReelsWorker, assignDay, autoFill, deleteReel,
};
