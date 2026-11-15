import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { PrismaClient } from '@prisma/client';
import youtube, { listChannels as youtubeChannels } from './youtube.service.js';

const execAsync = util.promisify(exec);
const prisma = new PrismaClient();

const ROTATION_ORDER = ['Ozaru_art', 'stlgratis', 'stl-gratis'];
const SETTINGS = {
  LAST_CHANNEL: 'HORIZONTAL_LAST_CHANNEL',
  LAST_LANGUAGE: 'HORIZONTAL_LAST_LANGUAGE',
  LAST_PUBLISHED_AT: 'HORIZONTAL_LAST_PUBLISHED_AT',
  AUTO_ENABLED: 'HORIZONTAL_AUTO_ENABLED', // "false" apaga la publicación automática
  SPACING_MINUTES: 'HORIZONTAL_SPACING_MINUTES', // minutos tras el reel (por defecto 120)
  LAST_AUTO_REEL: 'HORIZONTAL_LAST_AUTO_REEL' // id del último reel que ya disparó un video horizontal
};
const DEFAULT_SPACING_MINUTES = 120;

const HORIZONTAL_DIR = path.resolve('uploads', 'horizontal');
const COMPLETED_DIR = path.resolve(HORIZONTAL_DIR, 'completed');
const BRANDING_DIR = path.resolve(HORIZONTAL_DIR, 'branding');

export function ensureDirs() {
  fs.mkdirSync(HORIZONTAL_DIR, { recursive: true });
  fs.mkdirSync(COMPLETED_DIR, { recursive: true });
  fs.mkdirSync(BRANDING_DIR, { recursive: true });
}

// Barajado pseudo-aleatorio determinista con semilla (genera el mismo orden durante el día)
function seededShuffle(array, seed = 12345) {
  const arr = [...array];
  let s = Number(seed) || 12345;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const rnd = s / 233280;
    const j = Math.floor(rnd * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Resuelve la ruta absoluta del logo oficial
function getLogoAbsPath() {
  const custom = path.join(BRANDING_DIR, 'logo_watermark.png');
  if (fs.existsSync(custom)) return custom;
  const frontLogo = path.resolve('..', 'front_next', 'public', 'nuevo_horizontal.png');
  if (fs.existsSync(frontLogo)) return frontLogo;
  return null;
}

// Determina el canal en turno hoy y los siguientes
export async function getChannelSchedule() {
  const lastChannelSetting = await prisma.systemSetting.findUnique({ where: { key: SETTINGS.LAST_CHANNEL } });
  const lastChannel = lastChannelSetting?.value || ROTATION_ORDER[ROTATION_ORDER.length - 1];
  
  const lastIdx = ROTATION_ORDER.indexOf(lastChannel);
  const todayIdx = (lastIdx + 1) % ROTATION_ORDER.length;
  const tomorrowIdx = (todayIdx + 1) % ROTATION_ORDER.length;
  const nextIdx = (tomorrowIdx + 1) % ROTATION_ORDER.length;

  return [
    { id: ROTATION_ORDER[todayIdx].toLowerCase(), name: ROTATION_ORDER[todayIdx], handle: `@${ROTATION_ORDER[todayIdx]}`, status: 'today', turnLabel: 'Turno de Hoy', nextPublish: 'Próximo video (2 h tras el reel)' },
    { id: ROTATION_ORDER[tomorrowIdx].toLowerCase(), name: ROTATION_ORDER[tomorrowIdx], handle: `@${ROTATION_ORDER[tomorrowIdx]}`, status: 'tomorrow', turnLabel: 'Mañana', nextPublish: 'El siguiente' },
    { id: ROTATION_ORDER[nextIdx].toLowerCase(), name: ROTATION_ORDER[nextIdx], handle: `@${ROTATION_ORDER[nextIdx]}`, status: 'next', turnLabel: 'En 2 días', nextPublish: 'Dentro de dos' },
  ];
}

// Detecta el idioma en turno (alternando automáticamente entre Español 'es' e Inglés 'en')
export async function getNextLanguage() {
  const setting = await prisma.systemSetting.findUnique({ where: { key: SETTINGS.LAST_LANGUAGE } });
  if (setting?.value === 'en') return 'es';
  if (setting?.value === 'es') return 'en';

  const lastComp = await prisma.horizontalCompilation.findFirst({
    orderBy: { id: 'desc' }
  });
  const lastLang = (lastComp?.tags && typeof lastComp.tags === 'object' && lastComp.tags.language) || 'es';
  return lastLang === 'en' ? 'es' : 'en';
}

// Segundos que dura cada modelo en la recopilación (YouTube exige capítulos de 10 s como mínimo)
const CLIP_SECONDS = 10;

const hasVideoFile = (m) => Boolean(m?.videoPath) && fs.existsSync(path.resolve('uploads', String(m.videoPath).replace(/^\/+/, '')));

// Link a la página del modelo en stlgratis.com (/es/asset/<slug> o /en/asset/<slug>), con UTM para medir el tráfico
function modelLink(asset, reel, language) {
  const lang = language === 'en' ? 'en' : 'es';
  // Las páginas van por slug (por id dan 404); sin slug se usa el link del reel en el idioma del video
  let base = asset?.slug
    ? `https://stlgratis.com/${lang}/asset/${asset.slug}`
    : (reel.link ? String(reel.link).replace(/stlgratis\.com\/(es|en)\//, `stlgratis.com/${lang}/`) : null);
  if (!base) return `https://stlgratis.com/${lang === 'en' ? 'en' : ''}`;
  try {
    const url = new URL(base);
    url.searchParams.set('utm_source', 'youtube');
    url.searchParams.set('utm_medium', 'horizontal');
    url.searchParams.set('utm_campaign', 'recopilacion');
    base = url.toString();
  } catch {}
  return base;
}

// Obtiene los 20 modelos para la próxima recopilación (1 Hero + 19 en descanso)
export async function getUpcomingSelection(heroId = null, language = 'es') {
  let hero = null;
  if (heroId) {
    hero = await prisma.reelPost.findUnique({ where: { id: Number(heroId) } });
  }

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

  if (!hero) {
    // 1. Prioridad: Reel publicado hoy
    hero = await prisma.reelPost.findFirst({
      where: {
        approved: true,
        status: 'PUBLISHED',
        publishedAt: { gte: startOfDay, lte: endOfDay }
      },
      orderBy: { publishedAt: 'desc' }
    });
  }

  if (!hero) {
    // 2. Prioridad: Último reel publicado en general
    hero = await prisma.reelPost.findFirst({
      where: {
        approved: true,
        status: 'PUBLISHED'
      },
      orderBy: { publishedAt: 'desc' }
    });
  }

  if (!hero) {
    // 3. Fallback: Reel programado más reciente
    hero = await prisma.reelPost.findFirst({
      where: { approved: true },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }]
    });
  }

  // Solo entran reels cuyo video está en el servidor: si faltara uno, el render lo saltaría y los capítulos se desfasarían
  if (hero && !hasVideoFile(hero)) hero = null;
  const heroExcludeId = hero?.id || 0;

  // Pool de candidatos en descanso (menor uso en horizontal primero)
  let candidatePool = await prisma.reelPost.findMany({
    where: {
      id: { not: heroExcludeId },
      approved: true,
      OR: [
        { status: 'PUBLISHED' },
        { scheduledAt: { lte: now } }
      ]
    },
    orderBy: [
      { horizontalUsesCount: 'asc' },
      { lastUsedInHorizontal: 'asc' },
      { id: 'desc' }
    ],
    take: 45
  });

  // Si hay menos de 19 publicados, completar con otros reels aprobados del catálogo
  if (candidatePool.length < 19) {
    const excludeIds = [heroExcludeId, ...candidatePool.map(m => m.id)];
    const additional = await prisma.reelPost.findMany({
      where: {
        id: { notIn: excludeIds },
        approved: true
      },
      orderBy: [
        { horizontalUsesCount: 'asc' },
        { lastUsedInHorizontal: 'asc' },
        { id: 'desc' }
      ],
      take: 19 - candidatePool.length
    });
    candidatePool = [...candidatePool, ...additional];
  }
  candidatePool = candidatePool.filter(hasVideoFile);

  // Deduplicar por personaje (assetId o título) para que ningún personaje salga repetido
  const seenCharacters = new Set();
  const heroKey = hero?.assetId ? `asset_${hero.assetId}` : (hero?.assetTitle || '').toLowerCase().trim();
  if (heroKey) seenCharacters.add(heroKey);

  const uniqueCandidates = [];
  for (const m of candidatePool) {
    const key = m.assetId ? `asset_${m.assetId}` : (m.assetTitle || m.title || `id_${m.id}`).toLowerCase().trim();
    if (key && seenCharacters.has(key)) continue;
    if (key) seenCharacters.add(key);
    uniqueCandidates.push(m);
  }

  // Semilla fija del día (año + mes + día + heroId) para consistencia absoluta en todo el día
  const daySeed = (now.getFullYear() * 10000) + ((now.getMonth() + 1) * 100) + now.getDate() + (hero?.id || 0);
  const shuffledCandidates = seededShuffle(uniqueCandidates, daySeed);
  const restingModels = shuffledCandidates.slice(0, 19);

  // El Hero va SIEMPRE de #1 (apertura con el último reel del día)
  // y los 19 restantes van barajados sin repetir personajes
  const allSelected = hero ? [hero, ...restingModels] : restingModels;

  // Datos de cada asset: título en inglés y slug para el link a su página
  const assetMap = new Map();
  const assetIds = allSelected.map(m => m.assetId).filter(Boolean);
  if (assetIds.length > 0) {
    try {
      const assets = await prisma.asset.findMany({
        where: { id: { in: assetIds } },
        select: { id: true, titleEn: true, title: true, slug: true }
      });
      for (const a of assets) assetMap.set(a.id, a);
    } catch {}
  }

  // Capítulos: cada modelo dura exactamente CLIP_SECONDS en el video (el render recorta o repite el reel)
  const timestamps = allSelected.map((m, idx) => {
    const startSec = idx * CLIP_SECONDS;
    const timeStr = `${Math.floor(startSec / 60)}:${String(startSec % 60).padStart(2, '0')}`;
    const asset = m.assetId ? assetMap.get(m.assetId) : null;
    const rawTitle = (language === 'en' && asset)
      ? (asset.titleEn || asset.title)
      : (m.assetTitle || m.title || `Modelo ${m.id}`);

    return {
      index: idx + 1,
      time: timeStr,
      id: m.id,
      assetId: m.assetId,
      title: String(rawTitle).replace(/^STL\s*[-–:]\s*/i, ''),
      link: modelLink(asset, m, language),
      isHero: idx === 0
    };
  });
  const currentSec = allSelected.length * CLIP_SECONDS;

  return { hero, restingModels, allSelected, timestamps, totalDurationSec: currentSec };
}

// Redacta la descripción completa optimizada para YouTube (base estándar con capítulos intactos)
export function buildDescription(timestamps, language = 'es') {
  if (language === 'en') {
    const intro = `🔥 Discover the ultimate TOP 20 3D printable models and premium STL files ready for resin and filament 3D printing!

From iconic action figures and anime characters to ultra-detailed collectibles. All files are fully optimized and available for direct download on our official platform.

🔗 DOWNLOAD ALL MODELS AT: https://stlgratis.com/

⏱️ CHAPTERS & DIRECT LINKS TO EACH MODEL:`;

    const chapters = timestamps.map(t => `${t.time} - #${t.index} ${t.title} (${t.link})`).join('\n');

    const footer = `⭐ Subscribe to the channel to never miss daily 3D printing showcases and let us know in the comments which figure was your favorite!

#STL #3DPrinting #3DPrint #AnimeSTL #MarvelSTL #ActionFigures #STLGratis #3DFigure #Collectible3D #ResinPrinting #FDMSlicer`;

    return `${intro}\n${chapters}\n\n${footer}`;
  }

  const intro = `🔥 ¡Descubre la recopilación definitiva de los 20 mejores modelos 3D y archivos STL listos para imprimir en resina y filamento!

Desde figuras de acción icónicas y anime hasta los coleccionables más detallados. Todos los archivos están optimizados y listos para descarga directa en nuestra plataforma oficial.

🔗 DESCARGA TODOS LOS MODELOS EN: https://stlgratis.com/

⏱️ CAPÍTULOS Y ENLACES DIRECTOS A CADA MODELO:`;

  const chapters = timestamps.map(t => `${t.time} - #${t.index} ${t.title} (${t.link})`).join('\n');

  const footer = `⭐ Suscríbete al canal para no perderte nuevos lanzamientos diarios y déjanos en los comentarios cuál fue tu figura favorita.

#STL #3DPrinting #Impresion3D #AnimeSTL #MarvelSTL #ActionFigures #STLGratis #Miniaturas3D #Coleccionables3D`;

  return `${intro}\n${chapters}\n\n${footer}`;
}

// Genera metadata optimizada con Inteligencia Artificial (Gemini) para YouTube respetando el idioma y los capítulos
export async function generateAiMetadata({ heroId = null, channelName = null, language = null } = {}) {
  const currentLang = language || await getNextLanguage();
  const selection = await getUpcomingSelection(heroId, currentLang);
  const hero = selection.hero;
  const models = selection.allSelected;

  const heroName = (hero?.assetTitle || hero?.title || 'Figura Destacada').replace(/^STL\s*[-–:]\s*/i, '');
  const modelNames = selection.timestamps.map(t => t.title);
  const sampleNotable = modelNames.slice(0, 10).join(', ');

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  let aiResult = null;

  if (apiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

      const prompt = currentLang === 'en' ? `You are a high-level YouTube SEO expert and copywriter for "STLFREE / STL GRATIS" (stlgratis.com), a premier global platform for 3D printing STL files (figures, anime, comics, gaming, resin & filament).

We are creating the metadata for a TOP 20 3D Models compilation video (Horizontal 16:9 Showcase, ~3 minutes).
- Opening / Hero Model (#1): "${heroName}"
- Other notable models in this showcase: ${sampleNotable}
- Target language: ENGLISH. Everything must be written in natural, fluent, high-engagement English.

Generate the following in JSON:
1. "title": A catchy, high-CTR YouTube title in English (MAX 95 chars). Start with an emoji (🔥, ⚡, ⚔️). It MUST highlight "${heroName}" and mention other top characters or anime/gaming figures. End with "| Premium STL Files" or similar.
2. "intro": 2-3 engaging, well-written paragraphs in English introducing today's showcase. Emphasize the detail of the 3D sculpts, printing in resin (SLA) and filament (FDM), painting, and collecting. Mention that all files are ready for direct download at https://stlgratis.com/.
3. "outro": 1-2 paragraphs closing the video. Ask viewers which figure was their favorite, remind them to subscribe for daily releases and like the video.
4. "tags": An array of 15-20 specific YouTube SEO tags in English (e.g. "${heroName.split(' ')[0]}", franchises, "3DPrinting", "STLFiles", "STLGratis", "ResinPrint", "ActionFigures", "AnimeSTL").

Respond ONLY with valid JSON in this structure:
{
  "title": "...",
  "intro": "...",
  "outro": "...",
  "tags": ["..."]
}` : `You are a high-level YouTube SEO expert and copywriter for "STLFREE / STL GRATIS" (stlgratis.com), a premier platform for 3D printing STL files (figures, anime, comics, gaming, resin & filament).

We are creating the metadata for a TOP 20 3D Models compilation video (Horizontal 16:9 Showcase, ~3 minutes).
- Opening / Hero Model (#1): "${heroName}"
- Other notable models in this showcase: ${sampleNotable}
- Target language: Spanish.

Generate the following in JSON:
1. "title": A catchy, high-CTR YouTube title in Spanish (MAX 95 chars). Start with an emoji (🔥, ⚡, ⚔️). It MUST highlight "${heroName}" and mention other top characters or anime/action figures. End with "| Archivos STL Premium" or similar.
2. "intro": 2-3 engaging, well-written paragraphs (in Spanish) introducing today's showcase. Emphasize the detail of the 3D sculpts, printing in resin (SLA) and filament (FDM), painting, and collecting. Mention that all files are ready for direct download at https://stlgratis.com/.
3. "outro": 1-2 paragraphs closing the video. Ask viewers which figure was their favorite, remind them to subscribe for daily releases and like the video.
4. "tags": An array of 15-20 specific YouTube SEO tags. Include the main character names, franchises present, and 3D printing terms ("Impresion3D", "Modelos3D", "STLGratis", "Resina3D", "ActionFigures", "AnimeSTL").

Respond ONLY with valid JSON in this structure:
{
  "title": "...",
  "intro": "...",
  "outro": "...",
  "tags": ["..."]
}`;

      const resp = await ai.models.generateContent({
        model,
        contents: [prompt],
        config: { responseMimeType: 'application/json', temperature: 1.05 }
      });

      const raw = String(resp.text || '').trim();
      try {
        aiResult = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) aiResult = JSON.parse(m[0]);
      }
    } catch (err) {
      console.warn('[Horizontal] Error generando metadata con Gemini:', err.message);
    }
  }

  // Fallbacks si falla la IA
  const finalTitle = aiResult?.title || (currentLang === 'en'
    ? `🔥 TOP 20 Best 3D Printable Models: ${heroName} & More | Premium STL Files`
    : `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${heroName} y Más | Archivos STL Premium`);

  const intro = aiResult?.intro || (currentLang === 'en'
    ? `Take your 3D printing workshop to the next level! We present the ultimate compilation of the top 20 3D models and STL files ready to print in resin and filament.\n\nFrom iconic figures and anime statues to ultra-detailed collector pieces. All files are fully optimized for professional results and available for direct download on our official platform.\n\n🔗 DOWNLOAD ALL MODELS AT: https://stlgratis.com/`
    : `¡Eleva tu taller de impresión al siguiente nivel! Te presentamos la recopilación definitiva con los 20 mejores modelos 3D y archivos STL listos para imprimir en resina y filamento.\n\nDesde figuras icónicas y anime hasta los coleccionables más detallados de la comunidad. Todos los archivos están optimizados para un acabado profesional y disponibles para descarga directa en nuestra plataforma oficial.\n\n🔗 DESCARGA TODOS LOS MODELOS EN: https://stlgratis.com/`);

  const outro = aiResult?.outro || (currentLang === 'en'
    ? `⭐ Which of these figures is going to be your next 3D printing and painting project? Let us know your favorite in the comments and subscribe to never miss daily releases!`
    : `⭐ ¿Cuál de estas figuras será tu próximo proyecto de impresión y pintura? Déjanos tu favorita en los comentarios y suscríbete al canal para no perderte las recopilaciones diarias con nuevos lanzamientos exclusivos.`);

  const tags = Array.isArray(aiResult?.tags) && aiResult.tags.length > 0 
    ? aiResult.tags 
    : (currentLang === 'en'
      ? ['STL', '3D Printing', '3D Print', 'Anime STL', 'Action Figures', 'STLGratis', '3D Models', 'Resin Print', 'FDM 3D', '3D File']
      : ['STL', '3D Printing', 'Modelos 3D', 'Impresión 3D', 'Anime STL', 'Marvel STL', 'Dragon Ball STL', 'Figuras Coleccionables', 'Archivos STL Gratis', 'Resina 3D', 'Filamento PLA', 'STLGratis']);

  // RESPETAR EL TEMA DE LOS CAPITULOS AL 100%
  const chaptersHeader = currentLang === 'en' 
    ? '⏱️ CHAPTERS & DIRECT LINKS TO EACH MODEL:' 
    : '⏱️ CAPÍTULOS Y ENLACES DIRECTOS A CADA MODELO:';
  const chaptersBody = selection.timestamps.map(t => `${t.time} - #${t.index} ${t.title} (${t.link})`).join('\n');
  const hashtagsLine = tags.slice(0, 10).map(t => `#${String(t).replace(/[#\s]+/g, '')}`).join(' ');

  const finalDescription = `${intro.trim()}\n\n${chaptersHeader}\n${chaptersBody}\n\n${outro.trim()}\n\n${hashtagsLine}`;

  return {
    language: currentLang,
    title: finalTitle,
    description: finalDescription,
    intro,
    outro,
    tags,
    timestamps: selection.timestamps
  };
}

// Estado general del panel de videos horizontales
export async function getHorizontalStatus() {
  ensureDirs();
  const channels = await getChannelSchedule();
  const todayChannel = channels.find(c => c.status === 'today')?.name || ROTATION_ORDER[0];
  const currentLang = await getNextLanguage();

  const totalModels = await prisma.reelPost.count({ where: { approved: true } });
  const selection = await getUpcomingSelection(null, currentLang);

  const heroTitle = selection.hero?.assetTitle || selection.hero?.title || '';
  const cleanHeroTitle = heroTitle ? heroTitle.replace(/^STL\s*[-–:]\s*/i, '') : '';
  const title = currentLang === 'en'
    ? (cleanHeroTitle 
        ? `🔥 TOP 20 Best 3D Printable Models: ${cleanHeroTitle} & More | Premium STL Files`
        : '🔥 TOP 20 Best 3D Printable Models | Premium STL Files')
    : (cleanHeroTitle 
        ? `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${cleanHeroTitle} y Más | Archivos STL Premium`
        : '🔥 TOP 20 Mejores Modelos 3D de Acción & Anime | Archivos STL Premium');

  const description = selection.allSelected.length ? buildDescription(selection.timestamps, currentLang) : '';

  // KPIs (todos reales)
  const next = totalModels > 0 ? await nextAutoPublishInfo() : { label: 'Sin reels programados', note: '' };
  const connected = await youtubeChannels().catch(() => []);
  const norm = (v) => String(v || '').trim().replace(/^@/, '').toLowerCase();
  const channelConnected = connected.some(c => [c.title, c.handle, c.id].some(v => v && norm(v) === norm(todayChannel)));
  const lastPublished = await prisma.horizontalCompilation.findFirst({
    where: { status: 'PUBLISHED', publishedAt: { not: null } },
    orderBy: { publishedAt: 'desc' },
  });
  const kpis = {
    nextPublish: next.label,
    nextPublishNote: next.note,
    channelToday: todayChannel,
    channelConnected,
    languageToday: currentLang,
    lastPublished: lastPublished ? {
      date: fmtBogota(lastPublished.publishedAt),
      channel: lastPublished.channelName || lastPublished.channelId,
      url: lastPublished.youtubeUrl || (lastPublished.youtubeVideoId ? `https://youtube.com/watch?v=${lastPublished.youtubeVideoId}` : null),
    } : null,
    catalog: {
      total: totalModels,
      inTurn: selection.allSelected.length,
      inRest: Math.max(0, totalModels - selection.allSelected.length)
    }
  };

  const latestCompilation = await prisma.horizontalCompilation.findFirst({
    orderBy: { id: 'desc' }
  });

  const tags = currentLang === 'en' ? [
    'STL', '3D Printing', '3D Print', 'Anime STL', 'Action Figures', 
    cleanHeroTitle.split(' ')[0] || 'Anime', 'STLGratis', '3D Models', 
    'Resin Print', 'FDM 3D', '3D File'
  ].filter(Boolean) : [
    'STL', '3D Printing', 'Modelos 3D', 'Impresión 3D', 
    cleanHeroTitle.split(' ')[0] || 'Anime', 'Anime STL', 
    'Marvel STL', 'Dragon Ball STL', 'Figuras Coleccionables', 
    'Archivos STL Gratis', 'Resina 3D', 'Filamento PLA', 'STLGratis'
  ].filter(Boolean);

  // Última recopilación generada: el panel la muestra como "Último publicado" o "Lista para publicar"
  const latestTags = latestCompilation?.tags && typeof latestCompilation.tags === 'object' ? latestCompilation.tags : {};
  const latest = latestCompilation ? {
    id: latestCompilation.id,
    status: latestCompilation.status,
    title: latestCompilation.title,
    description: latestCompilation.description,
    tags: Array.isArray(latestCompilation.tags) ? latestCompilation.tags : (latestTags.tags || []),
    language: latestTags.language || 'es',
    channel: latestCompilation.channelName || latestCompilation.channelId,
    videoPath: latestCompilation.videoPath,
    durationSec: latestCompilation.durationSec,
    modelsCount: Array.isArray(latestCompilation.modelIds) ? latestCompilation.modelIds.length : 0,
    youtubeUrl: latestCompilation.youtubeUrl || (latestCompilation.youtubeVideoId ? `https://youtube.com/watch?v=${latestCompilation.youtubeVideoId}` : null),
    publishedAt: latestCompilation.publishedAt ? fmtBogota(latestCompilation.publishedAt) : null,
    errorMessage: latestCompilation.errorMessage || null,
  } : null;

  return {
    kpis,
    latest,
    channels,
    upcoming: {
      title,
      description,
      channel: todayChannel,
      language: currentLang,
      languageLabel: currentLang === 'en' ? 'Inglés (🇬🇧 EN)' : 'Español (🇪🇸 ES)',
      hero: selection.hero,
      modelsCount: selection.allSelected.length,
      durationSec: selection.totalDurationSec,
      timestamps: selection.timestamps,
      videoPath: latestCompilation?.videoPath || null,
      tags
    }
  };
}

// Obtener lista completa de modelos con su estado de rotación
export async function getHorizontalModels(filter = 'all') {
  const currentLang = await getNextLanguage();
  const selection = await getUpcomingSelection(null, currentLang);
  const turnIds = new Set(selection.allSelected.map(m => m.id));

  const allPosts = await prisma.reelPost.findMany({
    where: { approved: true },
    orderBy: [{ id: 'desc' }]
  });

  const mapped = allPosts.map(p => {
    const isHero = p.id === selection.hero?.id;
    const isTurn = turnIds.has(p.id);
    const turnPos = selection.allSelected.findIndex(m => m.id === p.id);

    return {
      id: p.id,
      assetId: p.assetId,
      videoPath: p.videoPath,
      title: p.assetTitle || p.title || `Modelo ${p.id}`,
      duration: Math.round(p.durationSec || 9),
      isHero,
      turnPosition: turnPos >= 0 ? turnPos + 1 : null,
      uses: p.horizontalUsesCount || 0,
      lastUsedAt: p.lastUsedInHorizontal,
      restDays: p.lastUsedInHorizontal ? Math.max(0, Math.floor((Date.now() - new Date(p.lastUsedInHorizontal).getTime()) / (1000 * 60 * 60 * 24))) : 99,
      status: isHero ? 'hero' : isTurn ? 'turn' : 'rest',
      thumb: null
    };
  });

  if (filter === 'turn') {
    return mapped
      .filter(m => m.status === 'hero' || m.status === 'turn')
      .sort((a, b) => (a.turnPosition || 99) - (b.turnPosition || 99));
  }
  if (filter === 'rest') return mapped.filter(m => m.status === 'rest');
  return mapped;
}

// Historial de compilaciones creadas
export async function getHorizontalHistory() {
  const list = await prisma.horizontalCompilation.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30
  });

  return list.map(item => ({
    id: String(item.id),
    title: item.title,
    channel: item.channelName || item.channelId,
    channelHandle: `@${item.channelName || item.channelId}`,
    date: item.publishedAt ? new Date(item.publishedAt).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Pendiente',
    duration: item.durationSec ? `${Math.floor(item.durationSec / 60)}:${String(Math.floor(item.durationSec % 60)).padStart(2, '0')} min` : '2:50 min',
    videoPath: item.videoPath,
    youtubeUrl: item.youtubeUrl || (item.youtubeVideoId ? `https://youtube.com/watch?v=${item.youtubeVideoId}` : null),
    fbSynced: item.fbSynced,
    status: item.status,
    errorMessage: item.errorMessage || null,
    language: (item.tags && typeof item.tags === 'object' && item.tags.language) || 'es',
    tags: Array.isArray(item.tags) ? item.tags : (item.tags?.tags || []),
    modelsCount: Array.isArray(item.modelIds) ? item.modelIds.length : 20,
    fileSize: item.fileSizeB ? `${(item.fileSizeB / (1024 * 1024)).toFixed(1)} MB` : '42.0 MB'
  }));
}

// Genera el archivo .mp4 con FFmpeg uniendo los 20 clips con fondo desenfocado y logo
export async function renderHorizontalVideo(models) {
  ensureDirs();
  const logoPath = getLogoAbsPath();
  const timestamp = Date.now();
  const tempDir = path.resolve(HORIZONTAL_DIR, `render_${timestamp}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const processedClips = [];

  try {
    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const rawVideoPath = path.resolve('uploads', String(model.videoPath || '').replace(/^\/+/, ''));
      if (!fs.existsSync(rawVideoPath)) continue;

      const outClip = path.join(tempDir, `clip_${i}.mp4`);

      // Filtro FFmpeg: fondo desenfocado + figura nítida al centro + logo opcional en top-left
      let filter = `[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=30,eq=brightness=-0.15[bg];[0:v]scale=-1:1080[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[base]`;
      let inputs = `-stream_loop -1 -i "${rawVideoPath}"`;

      if (logoPath) {
        inputs += ` -i "${logoPath}"`;
        filter += `;[1:v]scale=320:-1[logo];[base][logo]overlay=40:40[v]`;
      } else {
        filter += `;[base]null[v]`;
      }

      // Asegurar mínimo 10 segundos para capítulos nativos de YouTube
      const cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[v]" -map 0:a? -c:v libx264 -preset veryfast -threads 4 -crf 23 -r 24 -c:a aac -ar 48000 -ac 2 -b:a 128k -t ${CLIP_SECONDS} "${outClip}"`;
      await execAsync(cmd);
      processedClips.push(outClip);
    }

    if (processedClips.length === 0) throw new Error('No se pudo procesar ningún clip de video.');

    // Concatenación demuxer
    const listFile = path.join(tempDir, 'concat_list.txt');
    const fileContent = processedClips.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFile, fileContent, 'utf8');

    const finalOutPath = path.join(COMPLETED_DIR, `compilation_${timestamp}.mp4`);
    const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${finalOutPath}"`;
    await execAsync(concatCmd);

    const stats = fs.statSync(finalOutPath);
    return {
      filePath: finalOutPath,
      relPath: `horizontal/completed/compilation_${timestamp}.mp4`,
      sizeB: stats.size,
      durationSec: processedClips.length * CLIP_SECONDS
    };
  } finally {
    // Limpieza de clips temporales
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// Ejecuta la creación y registro de una recopilación
export async function createCompilation({ heroId = null, channelName = null, title = null, description = null, tags = null, language = null, render = false }) {
  const currentLang = language || await getNextLanguage();
  const selection = await getUpcomingSelection(heroId, currentLang);
  const channels = await getChannelSchedule();
  const targetChannel = channelName || channels.find(c => c.status === 'today')?.name || ROTATION_ORDER[0];

  const heroName = (selection.hero?.assetTitle || selection.hero?.title || '').replace(/^STL\s*[-–:]\s*/i, '');
  const finalTitle = title || (currentLang === 'en'
    ? `🔥 TOP 20 Best 3D Printable Models: ${heroName} & More | Premium STL Files`
    : `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${heroName} y Más | Archivos STL Premium`);
  const finalDescription = description || buildDescription(selection.timestamps, currentLang);

  let videoData = { relPath: null, sizeB: 0, durationSec: selection.totalDurationSec };

  if (render) {
    videoData = await renderHorizontalVideo(selection.allSelected);
  }

  // Preparamos los tags y guardamos el idioma
  const tagsObj = {
    ...(tags && typeof tags === 'object' ? tags : { tags: Array.isArray(tags) ? tags : [] }),
    language: currentLang
  };

  // Crear registro en la BD
  const record = await prisma.horizontalCompilation.create({
    data: {
      title: finalTitle,
      description: finalDescription,
      tags: tagsObj,
      channelId: targetChannel.toLowerCase(),
      channelName: targetChannel,
      heroPostId: selection.hero?.id || null,
      modelIds: selection.allSelected.map(m => m.id),
      durationSec: videoData.durationSec,
      fileSizeB: videoData.sizeB,
      videoPath: videoData.relPath,
      status: 'READY'
    }
  });

  // Actualizar cooldown de los modelos usados
  const now = new Date();
  await prisma.reelPost.updateMany({
    where: { id: { in: selection.allSelected.map(m => m.id) } },
    data: {
      lastUsedInHorizontal: now,
      horizontalUsesCount: { increment: 1 }
    }
  });

  // Guardar último canal usado para rotar el siguiente
  await prisma.systemSetting.upsert({
    where: { key: SETTINGS.LAST_CHANNEL },
    create: { key: SETTINGS.LAST_CHANNEL, value: targetChannel, description: 'Último canal donde se publicó un video horizontal' },
    update: { value: targetChannel }
  });

  // Guardar último idioma usado para alternar el siguiente (ES <-> EN)
  await prisma.systemSetting.upsert({
    where: { key: SETTINGS.LAST_LANGUAGE },
    create: { key: SETTINGS.LAST_LANGUAGE, value: currentLang, description: 'Último idioma en que se generó un video horizontal (es / en)' },
    update: { value: currentLang }
  });

  return record;
}

// Publica a YouTube
export async function publishToYouTube(compilationId) {
  const record = await prisma.horizontalCompilation.findUnique({ where: { id: Number(compilationId) } });
  if (!record) throw new Error('Recopilación no encontrada');
  if (record.status === 'PUBLISHED' && record.youtubeVideoId) throw new Error('Esta recopilación ya está publicada en YouTube');

  let videoAbsPath = null;
  if (record.videoPath) {
    videoAbsPath = path.resolve('uploads', record.videoPath);
  }

  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) {
    throw new Error('El archivo de video renderizado no se encuentra en el servidor.');
  }

  const tagsToSend = Array.isArray(record.tags) 
    ? record.tags 
    : (record.tags?.tags || ['STL', '3D Printing', 'Modelos 3D', 'Impresion 3D', 'STLGratis']);

  const result = await youtube.uploadHorizontalVideo({
    channelId: record.channelId,
    videoAbsPath,
    title: record.title,
    description: record.description,
    tags: tagsToSend,
    privacyStatus: 'public'
  });

  const updated = await prisma.horizontalCompilation.update({
    where: { id: record.id },
    data: {
      youtubeVideoId: result.id,
      youtubeUrl: result.url,
      status: 'PUBLISHED',
      publishedAt: new Date()
    }
  });

  return updated;
}

/** Última recopilación generada con video que aún no se ha publicado (la que sube el botón "Publicar"). */
export async function latestReadyCompilation() {
  return prisma.horizontalCompilation.findFirst({
    where: { status: 'READY', videoPath: { not: null } },
    orderBy: { id: 'desc' },
  });
}

// ─── Publicación automática: cada reel publicado dispara un video horizontal X minutos después ───

async function autoSettings() {
  const rows = await prisma.systemSetting.findMany({ where: { key: { in: [SETTINGS.AUTO_ENABLED, SETTINGS.SPACING_MINUTES, SETTINGS.LAST_AUTO_REEL] } } });
  const byKey = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const spacing = Number(byKey[SETTINGS.SPACING_MINUTES]);
  return {
    enabled: String(byKey[SETTINGS.AUTO_ENABLED] ?? 'true').toLowerCase() !== 'false',
    spacingMin: Number.isFinite(spacing) && spacing > 0 ? spacing : DEFAULT_SPACING_MINUTES,
    lastReelId: Number(byKey[SETTINGS.LAST_AUTO_REEL]) || 0,
    hasMarker: byKey[SETTINGS.LAST_AUTO_REEL] != null,
  };
}

// Solo cuentan los reels publicados en las últimas horas: si el servidor estuvo caído mucho tiempo, ese reel se salta
const AUTO_WINDOW_MS = 6 * 3600 * 1000;

/** Reel publicado que aún no tiene su video horizontal (el más reciente), o null. */
async function pendingTriggerReel({ spacingMin, lastReelId }) {
  return prisma.reelPost.findFirst({
    where: {
      id: { gt: lastReelId },
      status: 'PUBLISHED',
      publishedAt: { gte: new Date(Date.now() - AUTO_WINDOW_MS - spacingMin * 60000) },
    },
    orderBy: { publishedAt: 'desc' },
  });
}

const fmtBogota = (date) => new Date(date).toLocaleString('es-CO', {
  timeZone: 'America/Bogota', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
});
const spacingText = (min) => (min % 60 === 0 ? `${min / 60} h` : `${min} min`);

let autoRunning = false;

/** Hora real del próximo video horizontal (label) y de dónde sale (note), en hora de Colombia. */
export async function nextAutoPublishInfo() {
  const cfg = await autoSettings();
  if (!cfg.enabled) return { label: 'Automático apagado', note: 'No se publican solos' };
  if (autoRunning) return { label: 'Publicando ahora…', note: 'Generando la recopilación y subiéndola a YouTube' };
  const pending = cfg.hasMarker ? await pendingTriggerReel(cfg) : null;
  const base = pending
    ? new Date(pending.publishedAt)
    : (await prisma.reelPost.findFirst({
      where: { status: 'PENDING', approved: true, scheduledAt: { gte: new Date() } },
      orderBy: { scheduledAt: 'asc' },
    }))?.scheduledAt;
  if (!base) return { label: 'Sin reels programados', note: `Sale ${spacingText(cfg.spacingMin)} después del próximo reel` };
  return { label: fmtBogota(new Date(base).getTime() + cfg.spacingMin * 60000), note: '' };
}

/**
 * Lo llama el worker de reels cada minuto. Cuando pasan los minutos configurados desde que se publicó un reel,
 * genera la recopilación (con ese reel de protagonista) y la sube a YouTube. Cada reel dispara un solo intento:
 * si falla, avisa en el panel y se puede publicar a mano desde "Videos Horizontales".
 */
export async function publishDueHorizontal({ notify } = {}) {
  if (autoRunning) return;
  const cfg = await autoSettings();
  if (!cfg.enabled) return;
  // Primera vez: se toma como punto de partida el último reel ya publicado (no se publica nada por reels viejos)
  if (!cfg.hasMarker) {
    const last = await prisma.reelPost.findFirst({ where: { status: 'PUBLISHED' }, orderBy: { id: 'desc' }, select: { id: true } });
    await prisma.systemSetting.create({
      data: { key: SETTINGS.LAST_AUTO_REEL, value: String(last?.id || 0), description: 'Último reel que disparó un video horizontal automático' },
    });
    return;
  }
  const reel = await pendingTriggerReel(cfg);
  if (!reel || Date.now() < new Date(reel.publishedAt).getTime() + cfg.spacingMin * 60000) return;

  autoRunning = true;
  let record = null;
  try {
    // Se marca antes de empezar: si algo falla no se reintenta en bucle cada minuto
    await prisma.systemSetting.upsert({
      where: { key: SETTINGS.LAST_AUTO_REEL },
      create: { key: SETTINGS.LAST_AUTO_REEL, value: String(reel.id), description: 'Último reel que disparó un video horizontal automático' },
      update: { value: String(reel.id) },
    });
    console.log(`[HORIZONTAL] Reel ${reel.id}: generando la recopilación automática…`);
    record = await createCompilation({ heroId: reel.id, render: true });
    if (!record.videoPath) throw new Error('No se generó el archivo de video de la recopilación');
    const published = await publishToYouTube(record.id);
    console.log(`[HORIZONTAL] Reel ${reel.id}: publicado en ${published.channelName} → ${published.youtubeUrl}`);
  } catch (e) {
    console.error(`[HORIZONTAL] Reel ${reel.id}: falló la publicación automática:`, e.message);
    if (record) {
      await prisma.horizontalCompilation.update({ where: { id: record.id }, data: { status: 'FAILED', errorMessage: e.message } }).catch(() => {});
    }
    await notify?.({
      post: reel,
      title: 'Video horizontal: no se pudo publicar',
      detail: `La recopilación automática (${spacingText(cfg.spacingMin)} tras el reel) falló.\n\nError: ${e.message}\n\nPuedes publicarla a mano desde "Videos Horizontales".`,
    });
  } finally {
    autoRunning = false;
  }
}

export default {
  ensureDirs,
  publishDueHorizontal,
  nextAutoPublishInfo,
  latestReadyCompilation,
  getChannelSchedule,
  getNextLanguage,
  getUpcomingSelection,
  generateAiMetadata,
  getHorizontalStatus,
  getHorizontalModels,
  getHorizontalHistory,
  createCompilation,
  publishToYouTube
};
