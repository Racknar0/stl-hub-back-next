// Piloto automático de Pinterest: cada día prepara y programa los pines del día siguiente sin intervención.
// Flujo: huecos de mañana -> candidatos (tendencias, temporada, clásicos, exploración) -> Gemini escribe el
// texto y revisa la imagen -> tablero -> cola. El worker existente publica cada pin a su hora.
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { PrismaClient } from '@prisma/client';
import { GoogleGenAI } from '@google/genai';
import pinterestService from './pinterest.service.js';
import pinterestPublisherService from './pinterestPublisher.service.js';
import { getTrendSuggestions, matchAssetsForKeyword } from './pinterestTrends.service.js';
import { generatePinVariations } from './pinterestAi.service.js';
import { findForbiddenKeyword } from '../utils/pinterestForbiddenWords.js';
import { transporter } from '../controllers/nodeMailerController.js';

const prisma = new PrismaClient();

const CONFIG_KEY = 'pinterest_autopilot';
const STATE_KEY = 'pinterest_autopilot_state';
const SEASON_KEY = 'pinterest_autopilot_season';

export const TYPES = ['trend', 'season', 'classic', 'explore'];
export const DEFAULT_CONFIG = {
  enabled: false,
  publishPaused: false,
  runHour: 6,
  dailyTarget: 15,
  mix: { trend: 7, season: 3, classic: 3, explore: 2 },
};

// Horas del día (el servidor corre en America/Bogota) por orden de preferencia:
// tarde y noche primero porque el público de Pinterest es sobre todo de EE. UU.
const PREFERRED_HOURS = [18, 20, 15, 22, 17, 21, 14, 19, 23, 16, 0, 12, 10, 1, 13, 11, 9, 8, 2, 7, 3, 6, 4, 5];
const MAX_PER_KEYWORD = 2;
const CANDIDATE_BUFFER = 1.35;
const IMAGE_MAX_SIDE = 512;

let running = false;

// ---------- Ajustes (SystemSetting) ----------
async function readSetting(key, fallback) {
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

async function writeSetting(key, value, description) {
  const json = JSON.stringify(value);
  await prisma.systemSetting.upsert({
    where: { key },
    update: { value: json },
    create: { key, value: json, description },
  });
}

export async function getConfig() {
  const saved = await readSetting(CONFIG_KEY, {});
  return { ...DEFAULT_CONFIG, ...saved, mix: { ...DEFAULT_CONFIG.mix, ...(saved.mix || {}) } };
}

export async function updateConfig(patch = {}) {
  const current = await getConfig();
  const next = { ...current };
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  if (typeof patch.publishPaused === 'boolean') next.publishPaused = patch.publishPaused;
  if (patch.runHour !== undefined) {
    const h = parseInt(patch.runHour, 10);
    if (Number.isNaN(h) || h < 0 || h > 23) throw new Error('La hora debe estar entre 0 y 23.');
    next.runHour = h;
  }
  if (patch.mix) {
    const mix = {};
    for (const t of TYPES) {
      const v = parseInt(patch.mix[t] ?? current.mix[t], 10);
      if (Number.isNaN(v) || v < 0 || v > 15) throw new Error('Cada número de la mezcla debe estar entre 0 y 15.');
      mix[t] = v;
    }
    const total = TYPES.reduce((s, t) => s + mix[t], 0);
    if (total < 1 || total > 15) throw new Error('La mezcla debe sumar entre 1 y 15 pines.');
    next.mix = mix;
    next.dailyTarget = total;
  }
  await writeSetting(CONFIG_KEY, next, 'Configuración del piloto automático de Pinterest');

  // Al reanudar la publicación, los pines que se pasaron de hora se reparten desde ahora
  if (current.publishPaused && next.publishPaused === false) await rescheduleOverduePins();
  return next;
}

export async function getState() {
  return readSetting(STATE_KEY, { lastRunDay: null, lastRunAt: null, lastRunStatus: null });
}

export async function isPublishingPaused() {
  try { return (await getConfig()).publishPaused === true; } catch { return false; }
}

// ---------- Utilidades ----------
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function tomorrowRange(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2, 0, 0, 0);
  return { start, end, key: dayKey(start) };
}

const normalizeImagePath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^uploads\//, '');

function parseImages(images) {
  if (Array.isArray(images)) return images;
  if (typeof images === 'string') { try { const a = JSON.parse(images); return Array.isArray(a) ? a : []; } catch { return []; } }
  return [];
}

function isFlaggedAsset(a) {
  return (a.categories || []).some(c => findForbiddenKeyword(c.name) || findForbiddenKeyword(c.slug)) ||
    (a.tags || []).some(t => findForbiddenKeyword(t.name) || findForbiddenKeyword(t.nameEn)) ||
    [a.title, a.titleEn, a.description, a.descriptionEn, a.slug].some(findForbiddenKeyword);
}

// Reparte n pines según la mezcla configurada (método del mayor resto)
function scaleMix(mix, n) {
  const total = TYPES.reduce((s, t) => s + mix[t], 0) || 1;
  const exact = TYPES.map(t => ({ t, v: (mix[t] / total) * n }));
  const out = Object.fromEntries(exact.map(e => [e.t, Math.floor(e.v)]));
  let left = n - Object.values(out).reduce((s, v) => s + v, 0);
  exact.sort((a, b) => (b.v % 1) - (a.v % 1));
  for (const e of exact) { if (left <= 0) break; out[e.t] += 1; left -= 1; }
  return out;
}

// Toma hasta MAX_PER_KEYWORD por palabra, alternando palabras, para que no salgan todos del mismo tema
function roundRobin(groups, limit, used) {
  const picked = [];
  const perGroup = groups.map(() => 0);
  let progress = true;
  while (picked.length < limit && progress) {
    progress = false;
    groups.forEach((g, gi) => {
      if (picked.length >= limit || perGroup[gi] >= MAX_PER_KEYWORD) return;
      while (g.ids.length) {
        const id = g.ids.shift();
        if (used.has(id)) continue;
        used.add(id);
        picked.push({ assetId: id, keyword: g.keyword });
        perGroup[gi] += 1;
        progress = true;
        break;
      }
    });
  }
  return picked;
}

// ---------- Temporada (una consulta a Gemini por semana) ----------
async function getSeasonKeywords() {
  const now = new Date();
  const weekKey = `${now.getFullYear()}-W${Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 86400000 + 1) / 7)}`;
  const cached = await readSetting(SEASON_KEY, null);
  if (cached?.weekKey === weekKey && Array.isArray(cached.keywords)) return cached.keywords;

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) return [];
  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    `Today is ${dayKey(now)}. You work for a site of 3D printable STL files (figures, busts, anime, movies, games, home decor, cosplay, toys, gadgets).`,
    'List 6 English search keywords for holidays, seasons or events happening in the NEXT 30 to 60 days (not the ones ending this week) that match 3D printable models people search on Pinterest.',
    'Each keyword: 2-4 words, about a physical object. No adult content.',
    'Respond ONLY with valid JSON: {"keywords": ["..."]}',
  ].join('\n');
  try {
    const response = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(String(response?.text || '{}'));
    const keywords = (parsed.keywords || []).map(k => String(k).trim()).filter(k => k && !findForbiddenKeyword(k)).slice(0, 6);
    await writeSetting(SEASON_KEY, { weekKey, keywords }, 'Palabras de temporada del piloto automático (caché semanal)');
    return keywords;
  } catch (e) {
    console.warn('[PINTEREST][AUTOPILOT] No se pudieron obtener palabras de temporada:', e.message);
    return cached?.keywords || [];
  }
}

// ---------- Candidatos ----------
async function getExcludedAssetIds() {
  const [queued, rejected] = await Promise.all([
    prisma.pinterestPinQueue.findMany({ select: { assetId: true } }),
    prisma.pinterestAssetReview.findMany({ where: { verdict: 'REJECTED' }, select: { assetId: true } }),
  ]);
  return new Set([...queued.map(q => q.assetId), ...rejected.map(r => r.assetId)]);
}

async function collectCandidates(quota, excluded) {
  const used = new Set(excluded);
  const want = Object.fromEntries(TYPES.map(t => [t, Math.ceil(quota[t] * CANDIDATE_BUFFER)]));
  const candidates = { trend: [], season: [], classic: [], explore: [] };
  let trendsSnapshot = null;

  if (want.trend > 0) {
    try {
      const trends = await getTrendSuggestions();
      trendsSnapshot = { source: trends.source, generatedAt: trends.generatedAt, chips: (trends.trends || []).map(c => ({ keyword: c.keyword, from: c.from, count: c.count })) };
      const groups = (trends.trends || []).map(c => ({ keyword: c.keyword, ids: [...c.assetIds] }));
      candidates.trend = roundRobin(groups, want.trend, used);
    } catch (e) {
      console.warn('[PINTEREST][AUTOPILOT] Tendencias no disponibles:', e.message);
    }
  }

  if (want.season > 0) {
    const keywords = await getSeasonKeywords();
    const groups = [];
    for (const keyword of keywords) {
      const ids = await matchAssetsForKeyword(keyword, used).catch(() => []);
      if (ids.length) groups.push({ keyword, ids });
    }
    candidates.season = roundRobin(groups, want.season, used);
  }

  // Clásicos: los más descargados que nunca se han publicado. Se piden de más para cubrir huecos de otros tipos.
  const classicPool = await prisma.asset.findMany({
    where: { status: 'PUBLISHED', id: { notIn: [...used] } },
    orderBy: { downloads: 'desc' },
    take: Math.max(30, want.classic * 4),
    select: { id: true },
  });
  const classicIds = classicPool.map(a => a.id);

  // Exploración: novedades recientes, en orden aleatorio
  const explorePool = await prisma.asset.findMany({
    where: { status: 'PUBLISHED', id: { notIn: [...used, ...classicIds] } },
    orderBy: { createdAt: 'desc' },
    take: 80,
    select: { id: true },
  });
  const exploreIds = explorePool.map(a => a.id).sort(() => Math.random() - 0.5);

  for (const id of classicIds) {
    if (candidates.classic.length >= want.classic) break;
    if (!used.has(id)) { used.add(id); candidates.classic.push({ assetId: id, keyword: null }); }
  }
  for (const id of exploreIds) {
    if (candidates.explore.length >= want.explore) break;
    if (!used.has(id)) { used.add(id); candidates.explore.push({ assetId: id, keyword: null }); }
  }

  // Reserva para rellenar si algún tipo se queda corto (sin tendencias, sin Qdrant…)
  const reserve = [];
  for (const id of classicIds) if (!used.has(id)) { used.add(id); reserve.push({ assetId: id, keyword: null, type: 'classic' }); }

  return { candidates, reserve, trendsSnapshot };
}

// ---------- Revisión + texto con Gemini ----------
async function loadSmallImage(imagePath) {
  const buffer = await pinterestPublisherService.downloadImage(`/uploads/${imagePath}`);
  const small = await sharp(buffer).resize(IMAGE_MAX_SIDE, IMAGE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
  return { inlineData: { mimeType: 'image/jpeg', data: small.toString('base64') } };
}

async function prepareCandidate(cand, asset) {
  const images = parseImages(asset.images).map(normalizeImagePath).filter(Boolean);
  if (!images.length) return { status: 'skipped', reason: 'sin imágenes' };
  const imagePath = images[0];

  const previous = await prisma.pinterestAssetReview.findUnique({ where: { assetId: asset.id } });
  const alreadyApproved = previous?.verdict === 'OK';

  let imagePart;
  try { imagePart = await loadSmallImage(imagePath); }
  catch (e) { return { status: 'skipped', reason: `imagen no disponible (${e.message})` }; }

  const { variations, review } = await generatePinVariations({
    title: asset.titleEn || asset.title,
    description: asset.descriptionEn || asset.description,
    tags: (asset.tags || []).map(t => t.nameEn || t.name),
    category: asset.categories?.[0]?.name || 'General',
    imageParts: [imagePart],
    trendKeyword: cand.keyword || undefined,
    reviewImage: !alreadyApproved,
  });

  if (review) {
    await prisma.pinterestAssetReview.upsert({
      where: { assetId: asset.id },
      update: { imagePath, verdict: review.ok ? 'OK' : 'REJECTED', scores: review.scores, reason: review.reason, reviewedAt: new Date() },
      create: { assetId: asset.id, imagePath, verdict: review.ok ? 'OK' : 'REJECTED', scores: review.scores, reason: review.reason },
    });
    if (!review.ok) return { status: 'rejected', reason: review.reason };
  }

  const v = variations[0] || {};
  if (!v.pinTitle || String(v.pinDescription || '').length < 60) return { status: 'skipped', reason: 'la IA no devolvió un texto válido' };
  return { status: 'ok', imagePath, copy: v };
}

// ---------- Tableros ----------
async function createBoardResolver({ dryRun }) {
  let boards = [];
  try { boards = await pinterestService.listBoards(); } catch (e) { console.warn('[PINTEREST][AUTOPILOT] No se pudieron listar tableros:', e.message); }
  const byName = new Map(boards.map(b => [b.name.toLowerCase(), b.id]));
  const created = [];
  return {
    created,
    async resolve(categoryName) {
      const name = String(categoryName || 'General').trim();
      const key = name.toLowerCase();
      if (byName.has(key)) return byName.get(key);
      if (dryRun || boards.length === 0) return 'auto';
      try {
        const board = await pinterestService.createBoard(name, `3D Printable STL Files - ${name}`);
        byName.set(key, board.id);
        created.push(name);
        return board.id;
      } catch (e) {
        console.warn(`[PINTEREST][AUTOPILOT] No se pudo crear el tablero "${name}":`, e.message);
        byName.set(key, 'auto');
        return 'auto';
      }
    },
  };
}

// ---------- Programación ----------
function pickTimes(n, start, takenHours) {
  const hours = PREFERRED_HOURS.filter(h => !takenHours.has(h)).slice(0, n).sort((a, b) => a - b);
  return hours.map(h => new Date(start.getFullYear(), start.getMonth(), start.getDate(), h, 5 + Math.floor(Math.random() * 46), 0));
}

// Alterna tipos y categorías para que no salgan seguidos tres pines del mismo tema
function interleave(picks) {
  const buckets = TYPES.map(t => picks.filter(p => p.type === t));
  const out = [];
  while (buckets.some(b => b.length)) {
    for (const b of buckets) {
      if (!b.length) continue;
      const lastCat = out[out.length - 1]?.category;
      const idx = b.findIndex(p => p.category !== lastCat);
      out.push(b.splice(idx === -1 ? 0 : idx, 1)[0]);
    }
  }
  return out;
}

function persistPinImage(assetId, imagePath, i) {
  const UPLOADS_DIR = path.resolve('uploads');
  const PINS_DIR = path.join(UPLOADS_DIR, 'pinterest-pins');
  if (!fs.existsSync(PINS_DIR)) fs.mkdirSync(PINS_DIR, { recursive: true });
  const ext = path.extname(imagePath) || '.webp';
  const fileName = `pin_${assetId}_${Date.now()}_${i}${ext}`;
  const src = path.join(UPLOADS_DIR, imagePath);
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(PINS_DIR, fileName));
      return `pinterest-pins/${fileName}`;
    }
  } catch (e) {
    console.warn('[PINTEREST][AUTOPILOT] No se pudo copiar la imagen:', e.message);
  }
  return imagePath;
}

// ---------- Alertas ----------
async function notify({ title, body, error = false }) {
  try {
    await prisma.notification.create({ data: { title, body, status: 'UNREAD', type: 'SOCIAL', typeStatus: error ? 'ERROR' : 'SUCCESS' } });
  } catch (e) { console.error('[PINTEREST][AUTOPILOT] No se pudo guardar la notificación:', e.message); }
}

async function sendAlertEmail(subject, text) {
  const to = String(process.env.SELLER_EMAIL || '').trim();
  if (!to) return;
  try {
    await transporter.sendMail({ from: process.env.SMTP_EMAIL, to, subject, text });
  } catch (e) { console.error('[PINTEREST][AUTOPILOT] No se pudo enviar el correo de alerta:', e.message); }
}

// ---------- Ejecución ----------
export async function runAutopilot({ dryRun = false, trigger = 'manual' } = {}) {
  if (running) throw new Error('El piloto automático ya se está ejecutando.');
  running = true;
  const config = await getConfig();
  const { start, end, key } = tomorrowRange();
  const run = await prisma.pinterestAutopilotRun.create({ data: { day: key, dryRun, status: 'RUNNING' } });
  const summary = { day: key, trigger, target: config.dailyTarget, picks: [], rejected: [], skipped: [], boardsCreated: [] };

  try {
    let pinterestOk = true;
    try { await pinterestService.getValidAccessToken(); } catch { pinterestOk = false; }
    summary.pinterestOk = pinterestOk;

    const existing = await prisma.pinterestPinQueue.findMany({
      where: { scheduledAt: { gte: start, lt: end }, status: { in: ['PENDING', 'PUBLISHED'] } },
      select: { scheduledAt: true },
    });
    const needed = Math.max(0, config.dailyTarget - existing.length);
    summary.existing = existing.length;
    summary.needed = needed;

    if (needed > 0) {
      const quota = scaleMix(config.mix, needed);
      summary.quota = quota;
      const excluded = await getExcludedAssetIds();
      const { candidates, reserve, trendsSnapshot } = await collectCandidates(quota, excluded);
      summary.trends = trendsSnapshot;

      const allIds = [...TYPES.flatMap(t => candidates[t].map(c => c.assetId)), ...reserve.map(r => r.assetId)];
      const assets = await prisma.asset.findMany({
        where: { id: { in: allIds }, status: 'PUBLISHED' },
        select: {
          id: true, title: true, titleEn: true, description: true, descriptionEn: true, slug: true, images: true,
          categories: { select: { name: true, slug: true } },
          tags: { select: { name: true, nameEn: true } },
        },
      });
      const assetById = new Map(assets.map(a => [a.id, a]));

      const approved = [];
      const tryCandidate = async (cand, type) => {
        const asset = assetById.get(cand.assetId);
        if (!asset) return false;
        const label = asset.titleEn || asset.title;
        if (isFlaggedAsset(asset)) { summary.skipped.push({ assetId: asset.id, title: label, reason: 'palabra prohibida en el asset' }); return false; }
        try {
          const res = await prepareCandidate(cand, asset);
          if (res.status === 'ok') {
            approved.push({ type, keyword: cand.keyword, asset, imagePath: res.imagePath, copy: res.copy, category: asset.categories?.[0]?.name || 'General' });
            return true;
          }
          (res.status === 'rejected' ? summary.rejected : summary.skipped).push({ assetId: asset.id, title: label, reason: res.reason });
        } catch (e) {
          summary.skipped.push({ assetId: asset.id, title: label, reason: `error de IA: ${e.message}` });
        }
        return false;
      };

      // Cada tipo hasta cubrir su cupo (los candidatos de sobra solo se usan si hay descartes)
      const leftovers = [];
      for (const type of TYPES) {
        let got = 0;
        for (const cand of candidates[type]) {
          if (got >= quota[type]) { leftovers.push({ ...cand, type }); continue; }
          if (await tryCandidate(cand, type)) got += 1;
        }
      }
      // Rellenar huecos con los sobrantes y la reserva de clásicos
      for (const cand of [...leftovers, ...reserve]) {
        if (approved.length >= needed) break;
        await tryCandidate(cand, cand.type);
      }

      const picks = interleave(approved.slice(0, needed));
      const takenHours = new Set(existing.map(p => new Date(p.scheduledAt).getHours()));
      const times = pickTimes(picks.length, start, takenHours);
      const boards = await createBoardResolver({ dryRun });
      const UPLOADS_BASE = process.env.UPLOADS_BASE_URL || `http://localhost:${process.env.PORT || 3001}/uploads`;

      for (let i = 0; i < picks.length; i++) {
        const p = picks[i];
        const boardId = await boards.resolve(p.category);
        const hashtags = p.copy.pinHashtags?.length ? '\n\n' + p.copy.pinHashtags.map(h => '#' + h).join(' ') : '';
        const link = `https://stlgratis.com/en/asset/${p.asset.slug || p.asset.id}`;
        if (!dryRun) {
          const rel = persistPinImage(p.asset.id, p.imagePath, i);
          await prisma.pinterestPinQueue.create({
            data: {
              assetId: p.asset.id,
              scheduledAt: times[i],
              status: 'PENDING',
              boardId: boardId || 'Automático',
              title: p.copy.pinTitle,
              description: p.copy.pinDescription + hashtags,
              link,
              origin: p.type,
              filters: { flip: true, zoom: 1.05, imageUrl: `${UPLOADS_BASE}/${rel}`, imagePath: rel },
            },
          });
        }
        summary.picks.push({ assetId: p.asset.id, title: p.copy.pinTitle, type: p.type, keyword: p.keyword, category: p.category, board: boardId, scheduledAt: times[i], image: p.imagePath });
      }
      summary.boardsCreated = boards.created;
    }

    summary.scheduled = summary.picks.length;
    const status = summary.scheduled >= needed ? 'OK' : 'PARTIAL';
    await prisma.pinterestAutopilotRun.update({ where: { id: run.id }, data: { status, summary, trends: summary.trends || null, finishedAt: new Date() } });

    if (!dryRun) {
      await writeSetting(STATE_KEY, { lastRunDay: dayKey(new Date()), lastRunAt: new Date().toISOString(), lastRunStatus: status }, 'Estado del piloto automático de Pinterest');
      const byType = TYPES.map(t => `${t}: ${summary.picks.filter(p => p.type === t).length}`).join(' · ');
      await notify({
        title: `Piloto automático: ${summary.scheduled} pines programados para ${key}`,
        body: `Programados: ${summary.scheduled} de ${needed} necesarios (${byType}).\nDescartados por imagen: ${summary.rejected.length}.\nOmitidos: ${summary.skipped.length}.${summary.boardsCreated.length ? `\nTableros creados: ${summary.boardsCreated.join(', ')}` : ''}`,
        error: status !== 'OK',
      });
      if (!pinterestOk) {
        await sendAlertEmail('⚠️ Pinterest desconectado - el piloto automático no podrá publicar',
          'La conexión con Pinterest caducó o falló. Los pines se programaron, pero fallarán al publicarse hasta que reconectes la cuenta desde el calendario del dashboard (stlgratis.com/dashboard/pinterest).');
      }
      if (needed > 0 && summary.scheduled === 0) {
        await sendAlertEmail('⚠️ Piloto automático de Pinterest: no se programó ningún pin',
          `El piloto automático no encontró modelos válidos para ${key}. Descartados: ${summary.rejected.length}, omitidos: ${summary.skipped.length}. Revisa el panel de Pinterest.`);
      }
    }
    return { runId: run.id, status, summary };
  } catch (error) {
    console.error('[PINTEREST][AUTOPILOT] Error en la ejecución:', error);
    await prisma.pinterestAutopilotRun.update({ where: { id: run.id }, data: { status: 'ERROR', summary, error: error.message, finishedAt: new Date() } }).catch(() => {});
    if (!dryRun) {
      await writeSetting(STATE_KEY, { lastRunDay: dayKey(new Date()), lastRunAt: new Date().toISOString(), lastRunStatus: 'ERROR' }, 'Estado del piloto automático de Pinterest');
      await notify({ title: 'Piloto automático de Pinterest: error', body: error.message, error: true });
      await sendAlertEmail('❌ Error en el piloto automático de Pinterest', `La ejecución de hoy falló: ${error.message}\nNo se programaron pines para ${key}. Revisa el panel de Pinterest.`);
    }
    throw error;
  } finally {
    running = false;
  }
}

export const isAutopilotRunning = () => running;

// Reparte desde ahora los pines PENDING que se quedaron atrás durante la pausa (uno cada 20 min)
export async function rescheduleOverduePins() {
  const overdue = await prisma.pinterestPinQueue.findMany({
    where: { status: 'PENDING', scheduledAt: { lt: new Date() } },
    orderBy: { scheduledAt: 'asc' },
    select: { id: true },
  });
  const base = Date.now() + 5 * 60000;
  for (let i = 0; i < overdue.length; i++) {
    await prisma.pinterestPinQueue.update({ where: { id: overdue[i].id }, data: { scheduledAt: new Date(base + i * 20 * 60000) } });
  }
  return overdue.length;
}

// ---------- Programador diario ----------
let schedulerId = null;
export function startAutopilotScheduler(intervalMs = 5 * 60000) {
  if (schedulerId) return;
  const tick = async () => {
    try {
      const config = await getConfig();
      if (!config.enabled || running) return;
      const now = new Date();
      if (now.getHours() < config.runHour) return;
      const state = await getState();
      if (state.lastRunDay === dayKey(now)) return;
      console.log('[PINTEREST][AUTOPILOT] Iniciando ejecución diaria...');
      await runAutopilot({ trigger: 'schedule' });
    } catch (e) {
      console.error('[PINTEREST][AUTOPILOT] Fallo en el programador:', e.message);
    }
  };
  schedulerId = setInterval(tick, intervalMs);
  setTimeout(tick, 15000);
}

export default { getConfig, updateConfig, getState, runAutopilot, startAutopilotScheduler, isPublishingPaused, rescheduleOverduePins };
