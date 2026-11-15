import fs from 'fs';
import path from 'path';
import { PrismaClient } from '@prisma/client';
import { generateReelTexts, generateYoutubeVariant, generateFacebookVariant, generateInstagramVariant, mockReelTexts, isMockAi, captionBody } from './reelsAi.service.js';
import { metaConfigured, listFacebookPages, listInstagramAccounts, publishInstagramReel, publishFacebookReel, commentOnPublishedReel } from './metaReels.service.js';
import { dispatchReelNotification } from '../utils/reelsNotifications.js';
import { uploadShort, connectionStatus as youtubeStatus, listChannels as youtubeChannels } from './youtube.service.js';
import { publishVideo as publishTiktokVideo, connectionStatus as tiktokStatus, tiktokOptionsProblem } from './tiktok.service.js';
import { publishVideo as publishThreadsVideo, connectionStatus as threadsStatus, threadsText } from './threads.service.js';
import { getChannelVariantVideo, cleanVariants } from './reelsVideoVariants.service.js';
import { publishDueHorizontal } from './horizontalShowcase.service.js';

const prisma = new PrismaClient();

export const PLATFORMS = ['instagram', 'facebook', 'youtube', 'tiktok', 'threads'];
const SETTINGS = { defaultTime: 'REELS_DEFAULT_TIME', timeSpread: 'REELS_TIME_SPREAD', language: 'REELS_LANGUAGE', youtubePrivacy: 'REELS_YOUTUBE_PRIVACY' };
const DEFAULTS = { defaultTime: '18:00', timeSpread: 60, language: 'es', youtubePrivacy: 'public' };
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
        youtubeVariants: await youtubeVariantsFor(asset, texts, lang),
        facebookVariants: await facebookVariantsFor(asset, texts, lang),
        instagramVariants: await instagramVariantsFor(asset, texts, lang),
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

/** Título y descripción distintos para cada canal de YouTube que no es el principal. */
async function youtubeVariantsFor(asset, texts, language) {
  const channels = (await youtubeChannels().catch(() => [])).slice(1);
  if (!channels.length || isMockAi()) return null;
  const variants = {};
  for (const ch of channels) {
    try {
      variants[ch.id] = await generateYoutubeVariant({ asset, language, base: { title: texts.youtubeTitle, description: texts.youtubeDescription }, avoid: Object.values(variants) });
    } catch (e) {
      console.warn(`[REELS][AI] Variante de YouTube para ${ch.title}: ${e.message}`);
    }
  }
  return Object.keys(variants).length ? variants : null;
}

/** Caption distinto para cada Página de Facebook que no es la principal. */
async function facebookVariantsFor(asset, texts, language) {
  const pages = (await listFacebookPages().catch(() => [])).slice(1);
  if (!pages.length || isMockAi()) return null;
  const variants = {};
  for (const pg of pages) {
    try {
      variants[pg.id] = { caption: await generateFacebookVariant({ asset, language, base: texts.facebookCaption, avoid: Object.values(variants).map(v => v.caption) }) };
    } catch (e) {
      console.warn(`[REELS][AI] Variante de Facebook para ${pg.name}: ${e.message}`);
    }
  }
  return Object.keys(variants).length ? variants : null;
}

/** Caption distinto para cada cuenta de Instagram que no es la principal. */
async function instagramVariantsFor(asset, texts, language) {
  const accounts = (await listInstagramAccounts().catch(() => [])).slice(1);
  if (!accounts.length || isMockAi()) return null;
  const variants = {};
  for (const acc of accounts) {
    try {
      variants[acc.id] = { caption: await generateInstagramVariant({ asset, language, base: texts.instagramCaption, avoid: Object.values(variants).map(v => v.caption) }) };
    } catch (e) {
      console.warn(`[REELS][AI] Variante de Instagram para @${acc.username}: ${e.message}`);
    }
  }
  return Object.keys(variants).length ? variants : null;
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

/**
 * Reels sin publicar a los que les falta el texto propio de algún canal de YouTube o Página de Facebook extra.
 * Devuelve [{ id, missing: [channelId], missingFb: [pageId] }].
 */
export async function reelsMissingYoutubeVariants() {
  const [extra, extraPages, extraIg] = await Promise.all([
    youtubeChannels().then(c => c.slice(1)).catch(() => []),
    listFacebookPages().then(p => p.slice(1)).catch(() => []),
    listInstagramAccounts().then(a => a.slice(1)).catch(() => []),
  ]);
  if (!extra.length && !extraPages.length && !extraIg.length) return [];
  const posts = await prisma.reelPost.findMany({
    where: { status: { not: 'PUBLISHED' }, aiGenerated: true },
    select: { id: true, platforms: true, youtubeChannels: true, youtubeVariants: true, facebookPages: true, facebookVariants: true, instagramAccounts: true, instagramVariants: true },
  });
  const obj = (v) => (v && typeof v === 'object' ? v : {});
  return posts
    .filter(p => Array.isArray(p.platforms))
    .map((p) => {
      const chosen = Array.isArray(p.youtubeChannels) ? p.youtubeChannels : extra.map(c => c.id);
      const chosenPages = Array.isArray(p.facebookPages) ? p.facebookPages : extraPages.map(pg => pg.id);
      return {
        id: p.id,
        missing: p.platforms.includes('youtube') ? extra.filter(c => chosen.includes(c.id) && !obj(p.youtubeVariants)[c.id]?.title).map(c => c.id) : [],
        missingFb: p.platforms.includes('facebook') ? extraPages.filter(pg => chosenPages.includes(pg.id) && !obj(p.facebookVariants)[pg.id]?.caption).map(pg => pg.id) : [],
        missingIg: p.platforms.includes('instagram')
          ? extraIg.filter(a => (Array.isArray(p.instagramAccounts) ? p.instagramAccounts : extraIg.map(x => x.id)).includes(a.id) && !obj(p.instagramVariants)[a.id]?.caption).map(a => a.id)
          : [],
      };
    })
    .filter(p => p.missing.length || p.missingFb.length || p.missingIg.length);
}

let variantsRunning = false;
/** Genera en segundo plano los textos que faltan de los canales extra, sin tocar el resto de textos del reel. */
export async function fillMissingYoutubeVariants() {
  if (variantsRunning) return { queued: 0, running: true };
  const pending = await reelsMissingYoutubeVariants();
  if (!pending.length) return { queued: 0 };
  variantsRunning = true;
  (async () => {
    for (const { id, missing, missingFb, missingIg } of pending) {
      try {
        const post = await prisma.reelPost.findUnique({ where: { id } });
        if (!post || post.status === 'PUBLISHED' || post.publishing) continue;
        const asset = post.assetId ? await prisma.asset.findUnique({ where: { id: post.assetId } }) : null;
        const variants = { ...(post.youtubeVariants && typeof post.youtubeVariants === 'object' ? post.youtubeVariants : {}) };
        for (const channelId of missing) {
          variants[channelId] = await generateYoutubeVariant({
            asset, language: post.language, base: { title: post.title, description: post.youtubeDescription }, avoid: Object.values(variants),
          });
        }
        const fbVariants = { ...(post.facebookVariants && typeof post.facebookVariants === 'object' ? post.facebookVariants : {}) };
        for (const pageId of missingFb) {
          fbVariants[pageId] = { caption: await generateFacebookVariant({
            asset, language: post.language, base: post.facebookCaption || post.caption, avoid: Object.values(fbVariants).map(v => v.caption),
          }) };
        }
        const igVariants = { ...(post.instagramVariants && typeof post.instagramVariants === 'object' ? post.instagramVariants : {}) };
        for (const igId of missingIg) {
          igVariants[igId] = { caption: await generateInstagramVariant({
            asset, language: post.language, base: post.caption, avoid: Object.values(igVariants).map(v => v.caption),
          }) };
        }
        await prisma.reelPost.update({ where: { id }, data: { youtubeVariants: variants, facebookVariants: fbVariants, instagramVariants: igVariants } });
      } catch (e) {
        console.error(`[REELS][AI] Textos de canales extra del reel ${id}:`, e.message);
      }
    }
    variantsRunning = false;
  })();
  return { queued: pending.length };
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
  // Threads usa el caption de Instagram (sin su pie) + el link del modelo
  if (platforms.includes('threads') && !post.caption?.trim()) missing.push('caption (se usa también en Threads)');
  return missing;
}

// ---------- Publicación ----------
const hashtagLine = (post) => (Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags.map(h => `#${h}`).join(' ') : '');
const withHashtags = (text, post) => [String(text || '').trim(), hashtagLine(post)].filter(Boolean).join('\n\n');
const publicVideoUrl = (videoPath) => `${PUBLIC_UPLOADS_BASE}/${String(videoPath).split('/').map(encodeURIComponent).join('/')}`;

/**
 * Canales de YouTube de un reel: el principal (el primero conectado) usa la clave "youtube" y el título/descripción
 * del reel; los demás usan "youtube:<id>" y su propio texto. Los canales extra quedan "en espera" y el worker
 * los publica a su hora (~2 h, ~4 h después) para no salir a la vez.
 */
async function youtubeTargets(post) {
  const channels = await youtubeChannels().catch(() => []);
  if (!channels.length) return [];
  const chosen = Array.isArray(post.youtubeChannels) ? post.youtubeChannels : channels.map(c => c.id);
  const variants = post.youtubeVariants && typeof post.youtubeVariants === 'object' ? post.youtubeVariants : {};
  let extra = 0;
  return channels.filter(c => chosen.includes(c.id)).map((c) => {
    const primary = c.id === channels[0].id;
    const v = variants[c.id] || {};
    // Cada canal extra sale ~2 h después del anterior (con unos minutos al azar)
    const delayMin = primary ? 0 : (++extra) * 120 + Math.round((Math.random() * 2 - 1) * 20);
    return {
      key: primary ? 'youtube' : `youtube:${c.id}`,
      channelId: c.id,
      channelTitle: c.title,
      channelIndex: primary ? 0 : extra,
      title: (!primary && v.title) || post.title,
      description: (!primary && v.description) || post.youtubeDescription,
      delayMin,
    };
  });
}

/**
 * Páginas de Facebook de un reel: la principal usa la clave "facebook" y el caption del reel; las demás páginas
 * asignadas al usuario del sistema usan "facebook:<id>" y su propio caption. Las Páginas extra quedan "en espera"
 * y el worker las publica a su hora (~2 h, ~4 h después), con el comentario del link al momento.
 */
async function facebookTargets(post) {
  const pages = await listFacebookPages().catch(() => []);
  if (!pages.length) return [];
  const chosen = Array.isArray(post.facebookPages) ? post.facebookPages : pages.map(p => p.id);
  const variants = post.facebookVariants && typeof post.facebookVariants === 'object' ? post.facebookVariants : {};
  let extra = 0;
  return pages.filter(p => chosen.includes(p.id)).map((p) => {
    const primary = p.id === pages[0].id;
    // Cada Página extra sale ~2 h después de la anterior (con unos minutos al azar)
    const delayMin = primary ? 0 : (++extra) * 120 + Math.round((Math.random() * 2 - 1) * 20);
    return {
      key: primary ? 'facebook' : `facebook:${p.id}`,
      pageId: p.id,
      pageName: p.name,
      channelIndex: primary ? 0 : extra,
      caption: (!primary && variants[p.id]?.caption) || post.facebookCaption || post.caption,
      delayMin,
    };
  });
}

/**
 * Cuentas de Instagram de un reel: la principal usa la clave "instagram" y el caption del reel; las demás usan
 * "instagram:<id>" y su propio caption. Instagram no permite programar por API: las cuentas extra quedan
 * "en espera" y el worker las publica a su hora (~1 h y ~3 h después).
 */
async function instagramTargets(post) {
  const accounts = await listInstagramAccounts().catch(() => []);
  if (!accounts.length) return [];
  const chosen = Array.isArray(post.instagramAccounts) ? post.instagramAccounts : accounts.map(a => a.id);
  const variants = post.instagramVariants && typeof post.instagramVariants === 'object' ? post.instagramVariants : {};
  let extra = 0;
  return accounts.filter(a => chosen.includes(a.id)).map((a) => {
    const primary = a.id === accounts[0].id;
    const delayMin = primary ? 0 : (2 * (++extra) - 1) * 60 + Math.round((Math.random() * 2 - 1) * 15);
    return {
      key: primary ? 'instagram' : `instagram:${a.id}`,
      igUserId: a.id,
      username: a.username,
      channelIndex: primary ? 0 : extra,
      caption: (!primary && variants[a.id]?.caption) || post.caption,
      delayMin,
    };
  });
}

const PLATFORM_NAMES = { instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', tiktok: 'TikTok', threads: 'Threads' };

// Reels que se están subiendo ahora mismo (evita publicar dos veces el mismo si coinciden el worker y "Publicar ahora")
const inFlight = new Set();

// Cuenta extra (Instagram, Página de Facebook o canal de YouTube): no se publica aún; el worker la publica a su hora
const deferredResult = (target, info) => ({ ...info, deferred: true, publishAt: new Date(Date.now() + target.delayMin * 60000).toISOString() });

/**
 * Video de una cuenta: la principal usa el original y las extra la misma variante con filtros (espejo, zoom/giro)
 * que los canales de YouTube, para que no salga idéntico en todas. Devuelve la ruta local y la URL pública.
 */
async function accountVideo(post, target, label) {
  const abs = await getChannelVariantVideo({
    postId: post.id, originalAbsPath: toAbsVideoPath(post.videoPath), channelIndex: target.channelIndex || 0, channelTitle: label,
  });
  const rel = path.relative(path.resolve('uploads'), abs).split(path.sep).join('/');
  return { abs, url: publicVideoUrl(rel) };
}

async function publishToPlatform(platform, post, { now = false } = {}) {
  const link = platformLink(post.link, platform, post.id);
  if (platform === 'instagram' || platform.startsWith('instagram:')) {
    const target = (await instagramTargets(post)).find(t => t.key === platform);
    if (!target) throw new Error('Esa cuenta de Instagram ya no está vinculada a una Página asignada');
    const info = { igUserId: target.igUserId, username: target.username };
    if (target.delayMin > 0 && !now) return deferredResult(target, info);
    const video = await accountVideo(post, target, `Instagram @${target.username}`);
    const result = await publishInstagramReel({ igUserId: target.igUserId, videoUrl: video.url, caption: withHashtags(target.caption, post) });
    return { ...result, ...info };
  }
  if (platform === 'facebook' || platform.startsWith('facebook:')) {
    const target = (await facebookTargets(post)).find(t => t.key === platform);
    if (!target) throw new Error('Esa Página de Facebook ya no está asignada al usuario del sistema');
    const info = { pageId: target.pageId, pageName: target.pageName };
    if (target.delayMin > 0 && !now) return deferredResult(target, info);
    const firstComment = link ? `🔗 ${link}` : null;
    const video = await accountVideo(post, target, `Facebook ${target.pageName}`);
    const result = await publishFacebookReel({
      pageId: target.pageId, videoAbsPath: video.abs, videoUrl: video.url,
      caption: withHashtags(target.caption, post), firstComment,
    });
    return { ...result, ...info };
  }
  if (platform === 'youtube' || platform.startsWith('youtube:')) {
    const { youtubePrivacy } = await getSettings();
    const target = (await youtubeTargets(post)).find(t => t.key === platform);
    if (!target) throw new Error('Ese canal de YouTube ya no está conectado');
    const info = { channelId: target.channelId, channelTitle: target.channelTitle };
    if (target.delayMin > 0 && !now) return deferredResult(target, info);
    const description = [String(target.description || '').trim(), link].filter(Boolean).join(' ');

    const originalAbsPath = toAbsVideoPath(post.videoPath);
    const videoAbsPath = await getChannelVariantVideo({
      postId: post.id,
      originalAbsPath,
      channelIndex: target.channelIndex || 0,
      channelTitle: target.channelTitle,
    });

    const result = await uploadShort({
      channelId: target.channelId, videoAbsPath, title: target.title, description,
      tags: Array.isArray(post.hashtags) ? post.hashtags : [], privacyStatus: youtubePrivacy,
    });
    return { ...result, ...info };
  }
  if (platform === 'threads') {
    return publishThreadsVideo({ videoUrl: publicVideoUrl(post.videoPath), text: threadsText(captionBody(post.caption), link) });
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
    // YouTube se publica en cada canal elegido: cada uno es un destino aparte
    // Igual con Facebook: cada Página elegida es un destino aparte
    const ytTargets = platforms.includes('youtube') ? await youtubeTargets(post) : [];
    const fbTargets = platforms.includes('facebook') ? await facebookTargets(post) : [];
    // E Instagram: cada cuenta vinculada elegida es un destino aparte
    const igTargets = platforms.includes('instagram') ? await instagramTargets(post) : [];
    const targets = platforms.flatMap(p => (
      p === 'youtube' ? ytTargets.map(t => t.key)
        : p === 'facebook' ? fbTargets.map(t => t.key)
          : p === 'instagram' ? igTargets.map(t => t.key) : [p]));
    const nameOf = (key) => {
      if (key.startsWith('instagram:')) return `Instagram (@${igTargets.find(t => t.key === key)?.username || 'cuenta'})`;
      if (key.startsWith('youtube:')) return `YouTube (${ytTargets.find(t => t.key === key)?.channelTitle || 'canal'})`;
      if (key.startsWith('facebook:')) return `Facebook (${fbTargets.find(t => t.key === key)?.pageName || 'página'})`;
      return PLATFORM_NAMES[key] || key;
    };
    for (const p of targets) {
      if ((results[p]?.id && !results[p].simulated) || results[p]?.deferred) continue;
      try {
        // Si una cuenta en espera falló antes, al reintentar se publica ya
        const res = await publishToPlatform(p, post, { now: !!results[p]?.failed });
        results[p] = { ...res, ...(!res.deferred && { publishedAt: new Date().toISOString() }), simulated: false };
        console.log(res.deferred
          ? `[REELS] Reel ${post.id}: ${p} en espera hasta ${res.publishAt}`
          : `[REELS] Reel ${post.id} publicado en ${p}: ${res.url || res.id}`);
      } catch (e) {
        delete results[p];
        errors.push(`${nameOf(p)}: ${e.message}`);
        console.error(`[REELS] Reel ${post.id} falló en ${p}:`, e.message);
      }
    }

    const done = (p) => (results[p]?.id && !results[p].simulated) || results[p]?.deferred;
    const allDone = targets.length > 0 && targets.every(done);
    const published = targets.filter(p => results[p]?.id && !results[p].simulated);
    const publishedLinks = published.map(p => ({ label: `Publicado en ${nameOf(p)}`, url: results[p].url }));
    if (errors.length) {
      dispatchReelNotification({
        post,
        title: published.length ? 'Publicado solo en parte' : 'No se pudo publicar',
        detail: `${errors.join('\n')}\n\n${published.length ? `Sí se publicó en: ${published.map(nameOf).join(', ')}. ` : ''}Usa "Reintentar publicación": solo se reintentan las redes que fallaron.`,
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

/**
 * Páginas de Facebook programadas: cuando Facebook ya publicó el reel, pone el primer comentario con el link
 * (igual que en la Página principal). Si a las 12 h sigue sin poder, avisa y deja de intentarlo.
 */
export async function commentScheduledFacebookReels() {
  const posts = await prisma.reelPost.findMany({
    where: { updatedAt: { gte: new Date(Date.now() - 3 * 24 * 3600 * 1000) }, publishing: false },
  });
  for (const post of posts) {
    const results = post.results && typeof post.results === 'object' ? { ...post.results } : null;
    if (!results) continue;
    let changed = false;
    for (const [key, r] of Object.entries(results)) {
      if (!key.startsWith('facebook:') || !r?.pendingComment || !r.publishAt) continue;
      const dueAt = new Date(r.publishAt).getTime();
      if (Date.now() < dueAt + 2 * 60000) continue;
      let failure = null;
      try {
        const res = await commentOnPublishedReel({ pageId: r.pageId, videoId: r.id, message: r.pendingComment });
        if (res.published) {
          results[key] = { ...r, commentId: res.commentId };
          delete results[key].pendingComment;
          changed = true;
          console.log(`[REELS] Reel ${post.id}: comentario con link puesto en ${r.pageName || key}`);
          continue;
        }
        if (Date.now() > dueAt + 12 * 3600 * 1000) failure = 'Facebook no llegó a publicar el reel programado';
      } catch (e) {
        failure = e.message;
      }
      if (!failure) continue;
      results[key] = { ...r, commentError: failure };
      delete results[key].pendingComment;
      changed = true;
      dispatchReelNotification({
        post,
        level: 'WARNING',
        title: `Facebook (${r.pageName || 'página'}): reel sin comentario con el link`,
        detail: `No se pudo poner el primer comentario con el link.\n\nError: ${failure}\n\nPuedes añadirlo a mano en Facebook.`,
        links: [{ label: 'Reel de Facebook', url: r.url }, { label: 'Link a comentar', url: r.pendingComment.replace(/^🔗\s*/, '') }],
      });
    }
    if (changed) await prisma.reelPost.update({ where: { id: post.id }, data: { results } });
  }
}

const DEFERRED_PREFIXES = ['instagram:', 'facebook:', 'youtube:'];
// Plataforma y lista de cuentas elegidas del reel para cada tipo de cuenta extra
const DEFERRED_CHOICE = { instagram: 'instagramAccounts', facebook: 'facebookPages', youtube: 'youtubeChannels' };

function deferredName(key, r) {
  if (key.startsWith('instagram:')) return `Instagram (@${r.username || 'cuenta'})`;
  if (key.startsWith('facebook:')) return `Facebook (${r.pageName || 'página'})`;
  return `YouTube (${r.channelTitle || 'canal'})`;
}

/** true si el usuario quitó esa cuenta (o su red) del reel después de que quedara en espera. */
function deferredUnselected(key, post) {
  const [platform, id] = key.split(':');
  if (!(Array.isArray(post.platforms) ? post.platforms : []).includes(platform)) return true;
  const chosen = post[DEFERRED_CHOICE[platform]];
  return Array.isArray(chosen) && !chosen.includes(id);
}

let deferredRunning = false;
/**
 * Publica las cuentas extra (Instagram, Páginas de Facebook y canales de YouTube) que quedaron en espera cuando les
 * llega su hora. Si una falla, el reel queda en error y se avisa en el panel; "Reintentar" la publica al momento.
 */
export async function publishDeferredTargets() {
  const posts = await prisma.reelPost.findMany({
    where: { updatedAt: { gte: new Date(Date.now() - 3 * 24 * 3600 * 1000) }, publishing: false },
  });
  for (const post of posts) {
    const results = post.results && typeof post.results === 'object' ? { ...post.results } : null;
    if (!results || inFlight.has(post.id)) continue;
    const due = Object.entries(results).filter(([key, r]) => DEFERRED_PREFIXES.some(pre => key.startsWith(pre))
      && r?.deferred && new Date(r.publishAt).getTime() <= Date.now());
    if (!due.length) continue;
    inFlight.add(post.id);
    const errors = [];
    const warnings = [];
    const failedNames = [];
    try {
      for (const [key, r] of due) {
        // La cuenta se quitó del reel mientras esperaba: no se publica
        if (deferredUnselected(key, post)) {
          delete results[key];
          console.log(`[REELS] Reel ${post.id}: ${key} se quitó del reel, no se publica`);
          continue;
        }
        try {
          const res = await publishToPlatform(key, post, { now: true });
          results[key] = { ...res, publishAt: r.publishAt, publishedAt: new Date().toISOString(), simulated: false };
          console.log(`[REELS] Reel ${post.id} publicado en ${key}: ${res.url || res.id}`);
          if (res.commentError) warnings.push({ key, res });
        } catch (e) {
          results[key] = { ...r, deferred: false, failed: true, error: e.message };
          failedNames.push(deferredName(key, r));
          errors.push(`${deferredName(key, r)}: ${e.message}`);
          console.error(`[REELS] Reel ${post.id} falló en ${key}:`, e.message);
        }
      }
      await prisma.reelPost.update({
        where: { id: post.id },
        data: { results, ...(errors.length && { status: 'FAILED', errorMessage: errors.join(' | ') }) },
      });
      if (errors.length) {
        dispatchReelNotification({
          post,
          title: failedNames.length === 1 ? `No se pudo publicar en ${failedNames[0]}` : 'No se pudo publicar en varias cuentas',
          detail: `${errors.join('\n')}\n\nUsa "Reintentar publicación": se publicará al momento en esas cuentas.`,
        });
      }
      for (const { key, res } of warnings) {
        dispatchReelNotification({
          post,
          level: 'WARNING',
          title: `${deferredName(key, res)}: reel sin comentario con el link`,
          detail: `El reel se publicó, pero no se pudo poner el primer comentario con el link.\n\nError: ${res.commentError}\n\nPuedes añadir el comentario a mano en Facebook.`,
          links: [{ label: 'Reel de Facebook', url: res.url }, { label: 'Link a comentar', url: platformLink(post.link, 'facebook', post.id) }],
        });
      }
    } finally {
      inFlight.delete(post.id);
    }
  }
}

/**
 * Tareas que tocan los resultados de reels ya publicados: van una detrás de otra para que ninguna pise lo que
 * guardó la otra.
 */
async function runResultTasks() {
  if (deferredRunning) return;
  deferredRunning = true;
  try {
    // Solo para reels antiguos que quedaron programados en Facebook antes de pasar todo a "en espera"
    await commentScheduledFacebookReels().catch(e => console.error('[REELS] Comentarios FB:', e.message));
    await publishDeferredTargets().catch(e => console.error('[REELS] Cuentas en espera:', e.message));
  } finally {
    deferredRunning = false;
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
  workerTimer = setInterval(() => {
    publishDueReels().catch(e => console.error('[REELS] Worker:', e.message));
    runResultTasks();
    // Video horizontal automático unas horas después de cada reel (render largo: no bloquea el resto)
    publishDueHorizontal({ notify: dispatchReelNotification }).catch(e => console.error('[HORIZONTAL] Worker:', e.message));
  }, intervalMs);
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

/** Redes por defecto de un reel nuevo: YouTube, TikTok y Threads si su cuenta está conectada (TikTok va a borradores). */
export async function defaultPlatforms() {
  const [yt, tt, th] = await Promise.all([
    youtubeStatus().catch(() => ({ connected: false })),
    tiktokStatus().catch(() => ({ connected: false })),
    threadsStatus().catch(() => ({ connected: false })),
  ]);
  const connected = { youtube: yt.connected, tiktok: tt.connected, threads: th.connected };
  return PLATFORMS.filter(p => !(p in connected) || connected[p]);
}

export async function deleteReel(postId) {
  const existing = await prisma.reelPost.findUnique({ where: { id: postId } });
  if (!existing) throw Object.assign(new Error('Reel no encontrado'), { status: 404 });
  if (existing.publishing || inFlight.has(postId)) throw Object.assign(new Error('El reel se está publicando ahora mismo'), { status: 409 });
  await prisma.reelPost.delete({ where: { id: postId } });
  const stillUsed = await prisma.reelPost.count({ where: { videoPath: existing.videoPath } });
  if (!stillUsed) await fs.promises.rm(toAbsVideoPath(existing.videoPath), { force: true });
  await cleanVariants(postId);
}

export default {
  getSettings, saveSettings, processReelAi, enqueueAi, missingFields, publishReel, publishInBackground, publishDueReels,
  startReelsWorker, assignDay, autoFill, deleteReel, reelsMissingYoutubeVariants, fillMissingYoutubeVariants,
};
