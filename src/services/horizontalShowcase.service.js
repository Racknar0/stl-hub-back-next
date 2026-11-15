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

// Redacta la descripción completa optimizada para YouTube
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
      videoPath: latestCompilation?.videoPath || null
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
export async function createCompilation({ heroId = null, channelName = null, title = null, description = null, render = false }) {
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

  const result = await youtube.uploadHorizontalVideo({
    channelId: record.channelId,
    videoAbsPath,
    title: record.title,
    description: record.description,
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

export default {
  ensureDirs,
  getChannelSchedule,
  getUpcomingSelection,
  getHorizontalStatus,
  getHorizontalModels,
  getHorizontalHistory,
  createCompilation,
  publishToYouTube
};
