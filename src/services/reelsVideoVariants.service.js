import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

const VARIANTS_DIR = path.resolve('uploads', 'reels', 'variants');

function ensureVariantsDir() {
  if (!fs.existsSync(VARIANTS_DIR)) {
    fs.mkdirSync(VARIANTS_DIR, { recursive: true });
  }
}

/**
 * Ejecuta ffmpeg como promesa.
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg falló (código ${code}): ${stderr.slice(-300)}`));
    });
    proc.on('error', (err) => reject(err));
  });
}

/**
 * Resuelve o genera la variante de video específica para un canal de YouTube:
 * - Canal 0 (Principal - Ozaru_art): devuelve el video original sin tocar.
 * - Canal 1 (stlgratis): efecto espejo horizontal (hflip).
 * - Canal 2 (stl-gratis): espejo horizontal + ligero zoom e inclinación (1.5°).
 * - Canales adicionales: alternan entre los filtros anteriores.
 * 
 * Si FFmpeg llega a fallar, hace fallback automático al video original para no bloquear la subida.
 */
export async function getChannelVariantVideo({ postId, originalAbsPath, channelIndex = 0, channelTitle = '' }) {
  if (!originalAbsPath || !fs.existsSync(originalAbsPath)) {
    throw new Error('El archivo de video original no existe en el servidor');
  }

  // Canal principal: original sin procesar
  if (channelIndex <= 0) {
    return originalAbsPath;
  }

  ensureVariantsDir();

  const isFlipOnly = channelIndex % 2 === 1; // Canal 1 (y los impares)
  const variantType = isFlipOnly ? 'hflip' : 'hflip_tilt';
  const outFilename = `reel_${postId}_ch${channelIndex}_${variantType}.mp4`;
  const outPath = path.join(VARIANTS_DIR, outFilename);

  // Si ya fue generado previamente y tiene contenido, reutilizarlo
  try {
    const stat = await fs.promises.stat(outPath);
    if (stat.size > 1000) {
      console.log(`[REELS][VARIANTS] Reutilizando variante en caché para ${channelTitle || `canal #${channelIndex}`}: ${outFilename}`);
      return outPath;
    }
  } catch {
    // No existe aún, lo generamos a continuación
  }

  console.log(`[REELS][VARIANTS] Generando variante "${variantType}" para ${channelTitle || `canal #${channelIndex}`} (Reel #${postId})...`);

  // Filtros de video
  // Canal 1: Espejo horizontal puro
  // Canal 2: Espejo + escala 1.06 + rotación 1.5° + recorte proporcional garantizando dimensiones pares
  const videoFilter = isFlipOnly
    ? 'hflip'
    : 'hflip,scale=trunc(iw*1.06/2)*2:trunc(ih*1.06/2)*2,rotate=1.5*PI/180:ow=iw:oh=ih,crop=trunc(iw/1.06/2)*2:trunc(ih/1.06/2)*2,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1';

  const ffmpegArgs = [
    '-y',
    '-i', originalAbsPath,
    '-vf', videoFilter,
    '-map', '0:v:0',
    '-map', '0:a?', // mapea audio solo si existe
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    outPath,
  ];

  try {
    await runFfmpeg(ffmpegArgs);
    console.log(`[REELS][VARIANTS] ✓ Variante generada con éxito: ${outFilename}`);
    return outPath;
  } catch (err) {
    console.warn(`[REELS][VARIANTS] ⚠️ No se pudo generar variante con FFmpeg (${err.message}). Usando video original como fallback.`);
    // Limpiar archivo incompleto si quedó
    try { await fs.promises.rm(outPath, { force: true }); } catch {}
    return originalAbsPath;
  }
}

/**
 * Borra las variantes generadas de un reel cuando este se elimina.
 */
export async function cleanVariants(postId) {
  try {
    if (!fs.existsSync(VARIANTS_DIR)) return;
    const files = await fs.promises.readdir(VARIANTS_DIR);
    const prefix = `reel_${postId}_`;
    for (const f of files) {
      if (f.startsWith(prefix)) {
        await fs.promises.rm(path.join(VARIANTS_DIR, f), { force: true });
      }
    }
  } catch (e) {
    console.warn(`[REELS][VARIANTS] Error limpiando variantes de reel ${postId}:`, e.message);
  }
}

export default {
  getChannelVariantVideo,
  cleanVariants,
};
