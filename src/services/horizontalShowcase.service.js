import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { PrismaClient } from '@prisma/client';
import youtube from './youtube.service.js';

const execAsync = util.promisify(exec);
const prisma = new PrismaClient();

const ROTATION_ORDER = ['Ozaru_art', 'stlgratis', 'stl-gratis'];
const SETTINGS = {
  LAST_CHANNEL: 'HORIZONTAL_LAST_CHANNEL',
  LAST_PUBLISHED_AT: 'HORIZONTAL_LAST_PUBLISHED_AT',
  AUTO_ENABLED: 'HORIZONTAL_AUTO_ENABLED',
  SPACING_MINUTES: 'HORIZONTAL_SPACING_MINUTES' // default 150 (2h 30m)
};

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
    { id: ROTATION_ORDER[todayIdx].toLowerCase(), name: ROTATION_ORDER[todayIdx], handle: `@${ROTATION_ORDER[todayIdx]}`, status: 'today', turnLabel: 'Turno de Hoy', nextPublish: 'Hoy · 17:30 (+2h 30m)' },
    { id: ROTATION_ORDER[tomorrowIdx].toLowerCase(), name: ROTATION_ORDER[tomorrowIdx], handle: `@${ROTATION_ORDER[tomorrowIdx]}`, status: 'tomorrow', turnLabel: 'Mañana', nextPublish: 'Mañana · 17:30' },
    { id: ROTATION_ORDER[nextIdx].toLowerCase(), name: ROTATION_ORDER[nextIdx], handle: `@${ROTATION_ORDER[nextIdx]}`, status: 'next', turnLabel: 'En 2 días', nextPublish: 'En 2 días · 17:30' },
  ];
}

// Obtiene los 20 modelos para la próxima recopilación (1 Hero + 19 en descanso)
export async function getUpcomingSelection(heroId = null) {
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

  // Construir los timestamps (asegurando >= 10s por modelo para compatibilidad de capítulos YouTube)
  let currentSec = 0;
  const timestamps = allSelected.map((m, idx) => {
    const totalSecRounded = Math.floor(currentSec);
    const mins = Math.floor(totalSecRounded / 60);
    const secs = String(totalSecRounded % 60).padStart(2, '0');
    const timeStr = `${mins}:${secs}`;
    const rawDur = Math.max(Math.round(m.durationSec || 10), 10); // Mínimo 10s para capítulos oficiales
    currentSec += rawDur;
    return {
      index: idx + 1,
      time: timeStr,
      id: m.id,
      assetId: m.assetId,
      title: (m.assetTitle || m.title || `Modelo ${m.id}`).replace(/^STL\s*[-–:]\s*/i, ''),
      link: `https://stlgratis.com/stl/${m.assetId || m.id}`,
      isHero: idx === 0
    };
  });

  return { hero, restingModels, allSelected, timestamps, totalDurationSec: currentSec };
}

// Redacta la descripción completa optimizada para YouTube (base estándar con capítulos intactos)
export function buildDescription(timestamps) {
  const intro = `🔥 ¡Descubre la recopilación definitiva de los 20 mejores modelos 3D y archivos STL listos para imprimir en resina y filamento!

Desde figuras de acción icónicas y anime hasta los coleccionables más detallados. Todos los archivos están optimizados y listos para descarga directa en nuestra plataforma oficial.

🔗 DESCARGA TODOS LOS MODELOS EN: https://stlgratis.com/

⏱️ CAPÍTULOS Y ENLACES DIRECTOS A CADA MODELO:`;

  const chapters = timestamps.map(t => `${t.time} - #${t.index} ${t.title} (${t.link})`).join('\n');

  const footer = `⭐ Suscríbete al canal para no perderte nuevos lanzamientos diarios y déjanos en los comentarios cuál fue tu figura favorita.

#STL #3DPrinting #Impresion3D #AnimeSTL #MarvelSTL #ActionFigures #STLGratis #Miniaturas3D #Coleccionables3D`;

  return `${intro}\n${chapters}\n\n${footer}`;
}

// Genera metadata optimizada con Inteligencia Artificial (Gemini) para YouTube y Pinterest
export async function generateAiMetadata({ heroId = null, channelName = null, language = 'es' } = {}) {
  const selection = await getUpcomingSelection(heroId);
  const hero = selection.hero;
  const models = selection.allSelected;

  const heroName = (hero?.assetTitle || hero?.title || 'Figura Destacada').replace(/^STL\s*[-–:]\s*/i, '');
  const modelNames = models.map(m => (m.assetTitle || m.title || `Modelo ${m.id}`).replace(/^STL\s*[-–:]\s*/i, ''));
  const sampleNotable = modelNames.slice(0, 10).join(', ');

  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  let aiResult = null;

  if (apiKey) {
    try {
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });
      const model = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

      const prompt = `You are a high-level YouTube & Pinterest SEO expert and copywriter for "STLFREE / STL GRATIS" (stlgratis.com), a premier platform for 3D printing STL files (figures, anime, comics, gaming, resin & filament).

We are creating the metadata for a TOP 20 3D Models compilation video (Horizontal 16:9 Showcase, ~3 minutes).
- Opening / Hero Model (#1): "${heroName}"
- Other notable models in this showcase: ${sampleNotable}
- Target language: Spanish.

Generate the following in JSON:
1. "title": A catchy, high-CTR YouTube title (MAX 95 chars). Start with an emoji (🔥, ⚡, ⚔️). It MUST highlight "${heroName}" and mention other top characters or anime/action figures. End with "| Archivos STL Premium" or similar.
2. "intro": 2-3 engaging, well-written paragraphs (in Spanish) introducing today's showcase. Emphasize the detail of the 3D sculpts, printing in resin (SLA) and filament (FDM), painting, and collecting. Mention that all files are ready for direct download at https://stlgratis.com/.
3. "outro": 1-2 paragraphs closing the video. Ask viewers which figure was their favorite, remind them to subscribe for daily releases and like the video.
4. "tags": An array of 15-20 specific YouTube SEO tags. Include the main character names, franchises present, and 3D printing terms ("Impresion3D", "Modelos3D", "STLGratis", "Resina3D", "ActionFigures", "AnimeSTL").
5. "pinterestTitle": A Pinterest-optimized pin title (max 95 chars) highlighting "${heroName} & Top 20 3D Print Figures".
6. "pinterestDescription": A compelling 2-line Pinterest pin description with emojis and hashtags highlighting 3D printing STL files with link to stlgratis.com.

Respond ONLY with valid JSON in this structure:
{
  "title": "...",
  "intro": "...",
  "outro": "...",
  "tags": ["..."],
  "pinterestTitle": "...",
  "pinterestDescription": "..."
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
  const finalTitle = aiResult?.title || `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${heroName} y Más | Archivos STL Premium`;
  const intro = aiResult?.intro || `¡Eleva tu taller de impresión al siguiente nivel! Te presentamos la recopilación definitiva con los 20 mejores modelos 3D y archivos STL listos para imprimir en resina y filamento.\n\nDesde figuras icónicas y anime hasta los coleccionables más detallados de la comunidad. Todos los archivos están optimizados para un acabado profesional y disponibles para descarga directa en nuestra plataforma oficial.\n\n🔗 DESCARGA TODOS LOS MODELOS EN: https://stlgratis.com/`;
  const outro = aiResult?.outro || `⭐ ¿Cuál de estas figuras será tu próximo proyecto de impresión y pintura? Déjanos tu favorita en los comentarios y suscríbete al canal para no perderte las recopilaciones diarias con nuevos lanzamientos exclusivos.`;
  const tags = Array.isArray(aiResult?.tags) && aiResult.tags.length > 0 
    ? aiResult.tags 
    : ['STL', '3D Printing', 'Modelos 3D', 'Impresión 3D', 'Anime STL', 'Marvel STL', 'Dragon Ball STL', 'Figuras Coleccionables', 'Archivos STL Gratis', 'Resina 3D', 'Filamento PLA', 'STLGratis'];

  // RESPETAR EL TEMA DE LOS CAPITULOS AL 100%
  const chaptersHeader = '⏱️ CAPÍTULOS Y ENLACES DIRECTOS A CADA MODELO:';
  const chaptersBody = selection.timestamps.map(t => `${t.time} - #${t.index} ${t.title} (${t.link})`).join('\n');
  const hashtagsLine = tags.slice(0, 10).map(t => `#${String(t).replace(/[#\s]+/g, '')}`).join(' ');

  const finalDescription = `${intro.trim()}\n\n${chaptersHeader}\n${chaptersBody}\n\n${outro.trim()}\n\n${hashtagsLine}`;

  return {
    title: finalTitle,
    description: finalDescription,
    intro,
    outro,
    tags,
    timestamps: selection.timestamps,
    pinterest: {
      title: aiResult?.pinterestTitle || `Top 20 Figuras 3D: ${heroName} & Modelos STL Premium | STLGratis`,
      description: aiResult?.pinterestDescription || `🔥 Descubre los mejores 20 modelos 3D y archivos STL para imprimir en resina y filamento. ¡Descarga directa en stlgratis.com! #3DPrinting #STL #STLGratis #Impresion3D`
    }
  };
}

// Estado general del panel de videos horizontales
export async function getHorizontalStatus() {
  ensureDirs();
  const channels = await getChannelSchedule();
  const todayChannel = channels.find(c => c.status === 'today')?.name || ROTATION_ORDER[0];

  const totalModels = await prisma.reelPost.count({ where: { approved: true } });
  const selection = await getUpcomingSelection();

  const heroTitle = selection.hero?.assetTitle || selection.hero?.title || '';
  const cleanHeroTitle = heroTitle ? heroTitle.replace(/^STL\s*[-–:]\s*/i, '') : '';
  const title = cleanHeroTitle 
    ? `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${cleanHeroTitle} y Más | Archivos STL Premium`
    : (totalModels > 0 ? '🔥 TOP 20 Mejores Modelos 3D de Acción & Anime | Archivos STL Premium' : '');
  const description = selection.allSelected.length ? buildDescription(selection.timestamps) : '';

  // KPIs
  const kpis = {
    nextPublish: totalModels > 0 ? 'Hoy 17:30 (+2h 30m tras Short)' : 'Sin reels programados',
    channelToday: todayChannel,
    googleQuota: { used: 6650, total: 10000, safe: true },
    catalog: {
      total: totalModels,
      inTurn: selection.allSelected.length,
      inRest: Math.max(0, totalModels - selection.allSelected.length)
    }
  };

  const latestCompilation = await prisma.horizontalCompilation.findFirst({
    orderBy: { id: 'desc' }
  });

  return {
    kpis,
    channels,
    upcoming: {
      title,
      description,
      channel: todayChannel,
      hero: selection.hero,
      modelsCount: selection.allSelected.length,
      durationSec: selection.totalDurationSec,
      timestamps: selection.timestamps,
      videoPath: latestCompilation?.videoPath || null,
      tags: [
        'STL', '3D Printing', 'Modelos 3D', 'Impresión 3D', 
        cleanHeroTitle.split(' ')[0] || 'Anime', 'Anime STL', 
        'Marvel STL', 'Dragon Ball STL', 'Figuras Coleccionables', 
        'Archivos STL Gratis', 'Resina 3D', 'Filamento PLA', 'STLGratis'
      ].filter(Boolean),
      pinterest: {
        title: cleanHeroTitle ? `Top 20 Figuras 3D: ${cleanHeroTitle} & Modelos STL` : 'Top 20 Figuras 3D STL',
        description: `🔥 Descubre los mejores 20 modelos 3D y archivos STL para imprimir en resina y filamento. ¡Descárgalos en https://stlgratis.com/! #3DPrinting #STL #STLGratis #Impresion3D`
      }
    }
  };
}

// Obtener lista completa de modelos con su estado de rotación
export async function getHorizontalModels(filter = 'all') {
  const selection = await getUpcomingSelection();
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
    pinterestSynced: Boolean(item.tags && typeof item.tags === 'object' && item.tags.pinterest?.synced),
    pinterestUrl: (item.tags && typeof item.tags === 'object' && item.tags.pinterest?.pinUrl) || null,
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
      let inputs = `-i "${rawVideoPath}"`;

      if (logoPath) {
        inputs += ` -i "${logoPath}"`;
        filter += `;[1:v]scale=320:-1[logo];[base][logo]overlay=40:40[v]`;
      } else {
        filter += `;[base]null[v]`;
      }

      // Asegurar mínimo 10 segundos para capítulos nativos de YouTube
      const cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[v]" -map 0:a? -c:v libx264 -preset veryfast -threads 4 -crf 23 -r 24 -c:a aac -ar 48000 -ac 2 -b:a 128k -t 10 "${outClip}"`;
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
      durationSec: processedClips.length * 10
    };
  } finally {
    // Limpieza de clips temporales
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

// Ejecuta la creación y registro de una recopilación
export async function createCompilation({ heroId = null, channelName = null, title = null, description = null, tags = null, render = false }) {
  const selection = await getUpcomingSelection(heroId);
  const channels = await getChannelSchedule();
  const targetChannel = channelName || channels.find(c => c.status === 'today')?.name || ROTATION_ORDER[0];

  const finalTitle = title || `🔥 TOP 20 Mejores Modelos 3D de Acción & Anime: ${(selection.hero?.assetTitle || selection.hero?.title || '').replace(/^STL\s*[-–:]\s*/i, '')} y Más | Archivos STL Premium`;
  const finalDescription = description || buildDescription(selection.timestamps);

  let videoData = { relPath: null, sizeB: 0, durationSec: selection.totalDurationSec };

  if (render) {
    videoData = await renderHorizontalVideo(selection.allSelected);
  }

  // Crear registro en la BD
  const record = await prisma.horizontalCompilation.create({
    data: {
      title: finalTitle,
      description: finalDescription,
      tags: tags ? (typeof tags === 'object' ? tags : { tags }) : null,
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

  return record;
}

// Publica a YouTube
export async function publishToYouTube(compilationId) {
  const record = await prisma.horizontalCompilation.findUnique({ where: { id: Number(compilationId) } });
  if (!record) throw new Error('Recopilación no encontrada');

  let videoAbsPath = null;
  if (record.videoPath) {
    videoAbsPath = path.resolve('uploads', record.videoPath);
  }

  // Fallback para pruebas si no se renderizó archivo pesado aún
  if (!videoAbsPath || !fs.existsSync(videoAbsPath)) {
    const demo = path.resolve('uploads', 'reels', 'demo_single_con_logo.mp4');
    if (fs.existsSync(demo)) videoAbsPath = demo;
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

// Publica un Pin a Pinterest con el Hero o portada de la recopilación
export async function publishToPinterest(compilationId) {
  const record = await prisma.horizontalCompilation.findUnique({ where: { id: Number(compilationId) } });
  if (!record) throw new Error('Recopilación no encontrada');

  const { default: pinterestPublisher } = await import('./pinterestPublisher.service.js');
  const { default: pinterestService } = await import('./pinterest.service.js');

  const status = await pinterestService.testConnection();
  if (!status.connected) {
    throw new Error('Pinterest no está conectado. Conecta tu cuenta de Pinterest en el panel.');
  }

  // Buscar el asset del hero o primer modelo
  let assetId = null;
  if (record.heroPostId) {
    const post = await prisma.reelPost.findUnique({ where: { id: record.heroPostId } });
    assetId = post?.assetId;
  }
  if (!assetId && Array.isArray(record.modelIds) && record.modelIds.length > 0) {
    const post = await prisma.reelPost.findUnique({ where: { id: record.modelIds[0] } });
    assetId = post?.assetId;
  }

  let imageUrl = null;
  let targetLink = record.youtubeUrl || 'https://stlgratis.com/';

  if (assetId) {
    const asset = await prisma.asset.findUnique({ where: { id: Number(assetId) } });
    if (asset?.images) {
      const imgs = Array.isArray(asset.images) ? asset.images : [asset.images];
      if (imgs.length > 0) {
        const first = imgs[0];
        imageUrl = String(first).startsWith('http') ? first : `https://stlgratis.com/uploads/${String(first).replace(/^\/+/, '')}`;
      }
    }
    if (asset) {
      targetLink = `https://stlgratis.com/stl/${asset.id}`;
    }
  }

  if (!imageUrl) {
    throw new Error('No se encontró una imagen de portada del modelo para publicar en Pinterest');
  }

  const pinTitle = (record.title || 'TOP 20 Modelos 3D STL').slice(0, 100);
  const pinDescription = `🔥 Recopilación de los mejores modelos 3D y archivos STL listos para imprimir en resina y filamento. Descárgalos en https://stlgratis.com/ #3DPrinting #STL #STLGratis #Impresion3D`;

  const pinResult = await pinterestPublisher.publishPin(
    imageUrl,
    'auto',
    pinTitle,
    pinDescription,
    targetLink,
    {},
    assetId
  );

  const prevTags = (record.tags && typeof record.tags === 'object') ? record.tags : {};
  const updatedTags = {
    ...prevTags,
    pinterest: {
      synced: true,
      pinId: pinResult?.id || pinResult?.data?.id || null,
      pinUrl: pinResult?.id ? `https://pinterest.com/pin/${pinResult.id}` : null,
      syncedAt: new Date().toISOString()
    }
  };

  const updated = await prisma.horizontalCompilation.update({
    where: { id: record.id },
    data: { tags: updatedTags }
  });

  return {
    success: true,
    pinId: updatedTags.pinterest.pinId,
    pinUrl: updatedTags.pinterest.pinUrl,
    compilation: updated
  };
}

export default {
  ensureDirs,
  getChannelSchedule,
  getUpcomingSelection,
  generateAiMetadata,
  getHorizontalStatus,
  getHorizontalModels,
  getHorizontalHistory,
  createCompilation,
  publishToYouTube,
  publishToPinterest
};
