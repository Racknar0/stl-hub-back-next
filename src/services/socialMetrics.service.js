// Métricas por publicación en todas las redes (Facebook, Instagram, YouTube, Pinterest y Threads) para el panel del dashboard.
// Se toman los reels publicados por el sistema cuya hora de publicación cae en el rango pedido (como "Fecha de publicación"
// de Business Suite) y se consultan las APIs de cada red. Cada consulta se cachea unos minutos para no gastar cuota.
import { PrismaClient } from '@prisma/client';
import youtube from './youtube.service.js';
import threads from './threads.service.js';
import pinterestService from './pinterest.service.js';
import { listFacebookPages, listInstagramAccounts, facebookReelMetrics, instagramMediaMetrics } from './metaReels.service.js';

const prisma = new PrismaClient();
// Las cifras se guardan 30 min: el panel no consulta las redes en cada visita, solo con el botón Actualizar (fresh)
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map(); // clave -> { at, value }

const NETWORK_LABEL = { facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', pinterest: 'Pinterest', threads: 'Threads' };

// `ages` recoge la hora de cada dato usado, para decirle al panel qué tan viejo es el más antiguo
async function cached(key, loader, fresh = false, ages = null) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
    ages?.push(hit.at);
    return hit.value;
  }
  const value = await loader();
  cache.set(key, { at: Date.now(), value });
  ages?.push(Date.now());
  return value;
}

// Ejecuta tareas con un máximo de concurrencia para no saturar las APIs
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const EMPTY = { views: null, reach: null, likes: null, comments: null, shares: null, saves: null, clicks: null, avgWatchSec: null, totalWatchSec: null };

/**
 * Filas de métricas de los reels publicados entre `from` y `to` (fechas ISO), más la fila resumen de Pinterest.
 * `networks` (opcional) limita a algunas redes. Con `fresh` se ignora lo guardado y se consulta cada red en vivo.
 */
export async function getSocialMetrics({ from, to, networks = null, fresh = false }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(+start) || Number.isNaN(+end) || end < start) throw new Error('Rango de fechas no válido');
  const want = (n) => !networks || networks.includes(n);
  const ages = [];

  // Las cuentas extra publican horas después: se amplía la búsqueda y luego se filtra por la hora real de cada red
  // Un reel que falló en una sola red queda en FAILED y sin publishedAt, pero sí salió en las demás: se busca también
  // por su hora programada y se cuentan solo las redes con id (cada una con su propia hora de publicación)
  const searchWindow = { gte: new Date(start.getTime() - 3 * 86400000), lte: new Date(end.getTime() + 86400000) };
  const posts = await prisma.reelPost.findMany({
    where: { simulated: false, status: { in: ['PUBLISHED', 'FAILED'] }, OR: [{ publishedAt: searchWindow }, { publishedAt: null, scheduledAt: searchWindow }] },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, title: true, assetTitle: true, publishedAt: true, results: true, caption: true, facebookCaption: true, youtubeVariants: true, facebookVariants: true, instagramVariants: true, pinterestTitle: true },
  });

  // Título que se ve en la tabla: el real de cada cuenta (YouTube) o la primera frase de su texto (el resto de redes)
  const bodyLine = (text) => {
    const line = String(text || '').split('\n').map(l => l.trim()).find(l => l && !/^(🌐|📦)/.test(l) && !/^#/.test(l));
    return line ? (line.length > 110 ? `${line.slice(0, 107)}…` : line) : null;
  };
  const displayTitle = (post, network, account) => {
    const fallback = post.title || post.assetTitle || `Reel ${post.id}`;
    const primary = (p) => !account || account === p;
    if (network === 'youtube') return (account && post.youtubeVariants?.[account]?.title) || fallback;
    if (network === 'facebook') return bodyLine(account && post.facebookVariants?.[account]?.caption) || bodyLine(post.facebookCaption || post.caption) || fallback;
    if (network === 'instagram') return bodyLine(account && post.instagramVariants?.[account]?.caption) || bodyLine(post.caption) || fallback;
    if (network === 'pinterest') return post.pinterestTitle || fallback;
    return primary(null) ? bodyLine(post.caption) || fallback : fallback;
  };

  const [pages, igAccounts, ytChannels, threadsStatus] = await Promise.all([
    listFacebookPages().catch(() => []),
    listInstagramAccounts().catch(() => []),
    youtube.listChannels().catch(() => []),
    threads.connectionStatus().catch(() => ({})),
  ]);
  const pageName = Object.fromEntries(pages.map(p => [p.id, p.name]));
  const igName = Object.fromEntries(igAccounts.map(a => [a.id, `@${a.username}`]));
  const ytName = Object.fromEntries(ytChannels.map(c => [c.id, c.title]));
  const primaryYt = ytChannels[0]?.id;

  // 1. Entradas (una por post y red/cuenta) dentro del rango
  const entries = [];
  for (const post of posts) {
    for (const [key, r] of Object.entries(post.results || {})) {
      if (!r?.id || r.simulated || r.deferred || r.failed) continue;
      const [network, account] = key.split(':');
      if (!NETWORK_LABEL[network] || !want(network)) continue;
      const when = new Date(r.publishedAt || r.publishAt || post.publishedAt);
      if (when < start || when > end) continue;
      let accountId = account || (network === 'facebook' ? r.pageId || process.env.META_PAGE_ID : network === 'instagram' ? r.igUserId || process.env.META_IG_USER_ID : network === 'youtube' ? primaryYt : null);
      const label = network === 'facebook' ? pageName[accountId] || accountId
        : network === 'instagram' ? igName[accountId] || (r.username ? `@${r.username}` : '')
          : network === 'youtube' ? ytName[accountId] || ''
            : network === 'threads' ? (threadsStatus.account?.username ? `@${threadsStatus.account.username}` : '')
              : '';
      entries.push({ postId: post.id, title: displayTitle(post, network, account), network, key, id: r.id, url: r.url || null, publishedAt: when.toISOString(), accountId, account: label || NETWORK_LABEL[network], pageId: network === 'facebook' ? accountId : r.pageId, when });
    }
  }

  // 1b. Videos largos (recopilaciones horizontales): van a YouTube y a una Página de Facebook
  const compilations = await prisma.horizontalCompilation.findMany({
    where: { status: 'PUBLISHED', publishedAt: { gte: new Date(start.getTime() - 3 * 86400000), lte: new Date(end.getTime() + 86400000) } },
    orderBy: { publishedAt: 'desc' },
    select: { id: true, title: true, channelId: true, channelName: true, youtubeVideoId: true, youtubeUrl: true, fbSynced: true, fbPostId: true, publishedAt: true, tags: true },
  });
  for (const c of compilations) {
    const title = c.title;
    if (want('youtube') && c.youtubeVideoId) {
      const when = new Date(c.publishedAt);
      if (when >= start && when <= end) {
        entries.push({ postId: `h${c.id}`, long: true, title, network: 'youtube', key: 'youtube', id: c.youtubeVideoId, url: c.youtubeUrl || `https://youtube.com/watch?v=${c.youtubeVideoId}`, publishedAt: when.toISOString(), accountId: c.channelId, account: ytName[c.channelId] || c.channelName || 'YouTube', when });
      }
    }
    const fb = c.tags?.facebook;
    if (want('facebook') && c.fbSynced && c.fbPostId) {
      const when = new Date(fb?.publishedAt || c.publishedAt);
      if (when >= start && when <= end) {
        const pageId = fb?.pageId || process.env.META_PAGE_ID;
        entries.push({ postId: `h${c.id}`, long: true, title, network: 'facebook', key: 'facebook', id: c.fbPostId, url: fb?.url || null, publishedAt: when.toISOString(), accountId: pageId, account: pageName[pageId] || fb?.pageName || 'Facebook', pageId, when });
      }
    }
  }

  // 2. YouTube: una sola llamada por canal con todos sus videos
  const ytByChannel = {};
  for (const e of entries.filter(x => x.network === 'youtube')) (ytByChannel[e.accountId] ||= []).push(e.id);
  const ytStats = {};
  await Promise.all(Object.entries(ytByChannel).map(async ([channelId, ids]) => {
    try {
      Object.assign(ytStats, await cached(`yt:${channelId}:${ids.sort().join(',')}`, () => youtube.videoStats(channelId, ids), fresh, ages));
    } catch (e) { ids.forEach(id => { ytStats[id] = { error: e.message }; }); }
  }));

  // 3. Resto de redes: una llamada por publicación
  const todayStr = ymd(new Date());
  const rows = await pool(entries, 6, async (e) => {
    const base = { postId: e.postId, title: e.title, network: e.network, account: e.account, publishedAt: e.publishedAt, url: e.url, long: !!e.long, ...EMPTY };
    try {
      let m = {};
      if (e.network === 'facebook') m = await cached(`fb:${e.id}`, () => facebookReelMetrics({ pageId: e.pageId || e.accountId, videoId: e.id }), fresh, ages);
      else if (e.network === 'instagram') m = await cached(`ig:${e.id}`, () => instagramMediaMetrics({ mediaId: e.id }), fresh, ages);
      else if (e.network === 'youtube') { m = ytStats[e.id] || {}; if (m.error) throw new Error(m.error); }
      else if (e.network === 'threads') m = await cached(`th:${e.id}`, () => threads.postInsights(e.id), fresh, ages);
      else if (e.network === 'pinterest') {
        const p = await cached(`pin:${e.id}:${todayStr}`, () => pinterestService.getPinAnalytics(e.id, ymd(e.when), todayStr), fresh, ages);
        m = { views: p.VIDEO_MRC_VIEW ?? p.IMPRESSION ?? 0, saves: p.SAVE ?? 0, clicks: (p.OUTBOUND_CLICK ?? 0) + (p.PIN_CLICK ?? 0), avgWatchSec: p.VIDEO_AVG_WATCH_TIME ? Math.round(p.VIDEO_AVG_WATCH_TIME / 100) / 10 : null };
        m.reach = p.IMPRESSION ?? null; // impresiones = alcance aproximado en Pinterest
      }
      return { ...base, ...m };
    } catch (err) {
      return { ...base, error: err.message.replace(/\s+/g, ' ').slice(0, 160) };
    }
  });

  // 4. Fila resumen de Pinterest: toda la cuenta en el rango (los pines del piloto automático van agrupados)
  let pinterest = null;
  if (want('pinterest')) {
    try {
      const startDay = ymd(start);
      const endDay = ymd(end > new Date() ? new Date() : end);
      const [acct, pins] = await Promise.all([
        cached(`pinacct:${startDay}:${endDay}`, () => pinterestService.getAccountAnalytics(startDay, endDay), fresh, ages),
        prisma.pinterestPinQueue.count({ where: { status: 'PUBLISHED', scheduledAt: { gte: start, lte: end } } }),
      ]);
      pinterest = { network: 'pinterest', account: 'Pinterest · todos los pines', pins, views: acct.IMPRESSION ?? 0, clicks: (acct.OUTBOUND_CLICK ?? 0) + (acct.PIN_CLICK ?? 0), saves: acct.SAVE ?? 0 };
    } catch (err) {
      pinterest = { network: 'pinterest', account: 'Pinterest · todos los pines', error: err.message.slice(0, 160) };
    }
  }

  return { from: start.toISOString(), to: end.toISOString(), rows, pinterest, generatedAt: new Date().toISOString(), dataAt: new Date(ages.length ? Math.min(...ages) : Date.now()).toISOString() };
}

// ---------- Historial: fotos periódicas de las métricas ----------
const SNAPSHOT_EVERY_MS = 6 * 3600 * 1000; // foto automática cada 6 h
const SNAPSHOT_MIN_GAP_MS = 3600 * 1000;   // nunca dos fotos con menos de 1 h de diferencia
const SNAPSHOT_WINDOW_DAYS = 28;
const METRIC_KEYS = ['views', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks'];
let snapshotRunning = false;

/**
 * Guarda una foto de las métricas de los últimos 28 días. Sin `force` respeta el hueco mínimo de 1 h con la foto anterior.
 * `fresh` consulta las redes en vivo; si no, aprovecha lo que ya está en la caché de 30 min.
 */
export async function takeSnapshot({ fresh = false, force = false } = {}) {
  if (snapshotRunning) return { skipped: 'en curso' };
  snapshotRunning = true;
  try {
    if (!force) {
      const last = await prisma.socialMetricSnapshot.findFirst({ orderBy: { takenAt: 'desc' }, select: { takenAt: true } });
      if (last && Date.now() - last.takenAt.getTime() < SNAPSHOT_MIN_GAP_MS) return { skipped: 'reciente' };
    }
    const to = new Date();
    const from = new Date(to.getTime() - SNAPSHOT_WINDOW_DAYS * 86400000);
    const { rows } = await getSocialMetrics({ from: from.toISOString(), to: to.toISOString(), fresh });
    const takenAt = new Date();
    const data = rows.filter(r => !r.error).map(r => ({
      takenAt, postId: String(r.postId).slice(0, 24), network: r.network, account: String(r.account || '').slice(0, 120), publishedAt: new Date(r.publishedAt),
      ...Object.fromEntries(METRIC_KEYS.map(k => [k, r[k] == null ? null : Math.round(r[k])])),
    }));
    if (data.length) await prisma.socialMetricSnapshot.createMany({ data });
    return { saved: data.length };
  } finally {
    snapshotRunning = false;
  }
}

/** Arranca la tarea interna: cada 10 min mira si ya pasaron 6 h desde la última foto (así un reinicio del servidor no hace perder puntos). */
let snapshotTimer = null;
export function startSnapshotScheduler() {
  if (snapshotTimer) return;
  const tick = async () => {
    try {
      const last = await prisma.socialMetricSnapshot.findFirst({ orderBy: { takenAt: 'desc' }, select: { takenAt: true } });
      if (!last || Date.now() - last.takenAt.getTime() >= SNAPSHOT_EVERY_MS) await takeSnapshot({ fresh: true });
    } catch (e) { console.error('[SOCIAL-METRICS] Foto:', e.message); }
  };
  setTimeout(tick, 60000); // un minuto tras arrancar, para no competir con el resto del arranque
  snapshotTimer = setInterval(tick, 10 * 60000);
}

/**
 * Evolución entre `from` y `to`: por cada foto, lo ganado desde la foto anterior (por red y métrica), más los totales del periodo
 * anterior de igual duración para comparar. Una publicación nueva aporta todo lo que lleva; la primera foto de todas no genera punto.
 */
export async function getMetricsHistory({ from, to }) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(+start) || Number.isNaN(+end) || end < start) throw new Error('Rango de fechas no válido');
  const span = end.getTime() - start.getTime();
  const prevStart = new Date(start.getTime() - span - 1);
  // Una foto antes de la ventana sirve de base para el primer delta
  const base = await prisma.socialMetricSnapshot.findFirst({ where: { takenAt: { lt: prevStart } }, orderBy: { takenAt: 'desc' }, select: { takenAt: true } });
  const snaps = await prisma.socialMetricSnapshot.findMany({
    where: { takenAt: { gte: base?.takenAt || prevStart, lte: end } },
    orderBy: { takenAt: 'asc' },
  });
  const groups = new Map(); // takenAt(ms) -> filas
  for (const s of snaps) {
    const t = s.takenAt.getTime();
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(s);
  }
  const keyOf = (s) => `${s.postId}|${s.network}|${s.account}`;
  const points = [];
  let prev = null; // Map clave -> fila de la foto anterior
  for (const [t, list] of groups) {
    const cur = new Map(list.map(s => [keyOf(s), s]));
    if (prev) {
      const byNetwork = {};
      for (const s of list) {
        const p = prev.get(keyOf(s));
        const acc = (byNetwork[s.network] ||= Object.fromEntries(METRIC_KEYS.map(k => [k, 0])));
        for (const k of METRIC_KEYS) acc[k] += Math.max(0, (s[k] || 0) - (p?.[k] || 0));
      }
      points.push({ t, byNetwork });
    }
    prev = cur;
  }
  const inRange = points.filter(p => p.t >= start.getTime());
  const previous = points.filter(p => p.t >= prevStart.getTime() && p.t < start.getTime());
  const totalOf = (pts) => {
    const out = Object.fromEntries(METRIC_KEYS.map(k => [k, 0]));
    for (const p of pts) for (const n of Object.values(p.byNetwork)) for (const k of METRIC_KEYS) out[k] += n[k];
    return out;
  };
  return {
    from: start.toISOString(), to: end.toISOString(),
    points: inRange.map(p => ({ t: new Date(p.t).toISOString(), byNetwork: p.byNetwork })),
    previousTotals: previous.length ? totalOf(previous) : null,
    snapshots: groups.size,
  };
}

export default { getSocialMetrics, takeSnapshot, getMetricsHistory, startSnapshotScheduler };
