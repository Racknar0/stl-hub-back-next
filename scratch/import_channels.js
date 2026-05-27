import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

const RECOVERED_CHANNELS = [
  "-1001091861363",
  "-1001589113782",
  "-1001613462363",
  "-1001614983370",
  "-1001616357715",
  "-1001627942095",
  "-1001657147119",
  "-1001683196223",
  "-1001704198668",
  "-1001705585947",
  "-1001738938518",
  "-1001741954199",
  "-1001752470702",
  "-1001755942575",
  "-1001764163801",
  "-1001771548484",
  "-1001790932257",
  "-1001792794198",
  "-1001830244677",
  "-1001863384777",
  "-1001873602562",
  "-1001927021706",
  "-1001927860014",
  "-1001935048625",
  "-1001951241862",
  "-1001962710892",
  "-1001983126643",
  "-1002005767547",
  "-1002035633294",
  "-1002067557657",
  "-1002074269142",
  "-1002077900888",
  "-1002113955738",
  "-1002162437896",
  "BaldursGatestl",
  "Cyberpunkhehe",
  "FinalFantasyhehe",
  "GenshinImpactstl",
  "Impresion3DArg",
  "Kutonhehe",
  "LeagueofLegendshehe",
  "MortalKombatstl",
  "NierAutomatastl",
  "OnePunchManhehe",
  "PokemonSTL",
  "RUBIMhehstl",
  "Roninhehe",
  "STL3DPortugal",
  "STL3D_Pro",
  "STL_miniatures",
  "STLfilms",
  "Witcherstl",
  "ZenlessZoneZerostl",
  "darkstl",
  "demonslayerstl",
  "digimonstls",
  "exclusive3Dprinthehe",
  "funkosychivis",
  "gambodyhehe",
  "heheOnePiece",
  "hehefurry",
  "hehepink",
  "leagueoflegendsstl",
  "lixeirastl",
  "nomstlhehe",
  "oxohehe",
  "pikachuSTL",
  "saintsaiyastl",
  "samuraistl",
  "soharrypotter",
  "soportesdecoStl",
  "stlBerserk",
  "stlSailorMoon",
  "stlsoportes",
  "suportcontrol3d",
  "vikingstl",
  "warcrafthehe"
];

const LAST_DOWNLOADS_PATH = path.join(process.cwd(), 'data', 'last_downloads.json');

async function main() {
  console.log('--- INICIANDO IMPORTACIÓN DE CANALES RECUPERADOS ---');
  
  // 1. Leer last_downloads.json si existe
  let lastDownloads = {};
  if (fs.existsSync(LAST_DOWNLOADS_PATH)) {
    try {
      const content = fs.readFileSync(LAST_DOWNLOADS_PATH, 'utf8').trim();
      if (content) {
        lastDownloads = JSON.parse(content);
        console.log(`Leído last_downloads.json con ${Object.keys(lastDownloads).length} registros.`);
      }
    } catch (e) {
      console.warn('Advertencia al leer last_downloads.json:', e.message);
    }
  } else {
    console.log('No se encontró last_downloads.json (se crearán los canales con historial limpio).');
  }

  let created = 0;
  let updated = 0;

  for (const name of RECOVERED_CHANNELS) {
    const cleanName = String(name || '').trim();
    if (!cleanName) continue;

    // Buscar si el canal tiene registro en last_downloads
    const ld = lastDownloads[cleanName] || {};
    
    // Convertir fecha de YYYY-MM-DD HH:mm:ss a Date
    let lastDownloadedAt = null;
    if (ld.lastDownloadedAt) {
      lastDownloadedAt = new Date(ld.lastDownloadedAt);
      if (isNaN(lastDownloadedAt.getTime())) {
        lastDownloadedAt = null;
      }
    }

    const data = {
      label: cleanName, // temporal, el worker lo sincronizará con el título real de Telegram
      avatarUrl: null,
      lastMsgId: ld.lastMsgId ? Number(ld.lastMsgId) : null,
      lastFileName: ld.lastFileName || null,
      lastDownloadedAt,
      lastDownloadUrl: ld.url || null
    };

    try {
      const existing = await prisma.telegramChannel.findUnique({
        where: { name: cleanName }
      });

      if (!existing) {
        await prisma.telegramChannel.create({
          data: {
            name: cleanName,
            ...data
          }
        });
        created++;
      } else {
        // Solo actualizar si no tiene historial para no pisar datos más nuevos
        await prisma.telegramChannel.update({
          where: { name: cleanName },
          data: {
            lastMsgId: existing.lastMsgId || data.lastMsgId,
            lastFileName: existing.lastFileName || data.lastFileName,
            lastDownloadedAt: existing.lastDownloadedAt || data.lastDownloadedAt,
            lastDownloadUrl: existing.lastDownloadUrl || data.lastDownloadUrl
          }
        });
        updated++;
      }
    } catch (err) {
      console.error(`Error al procesar canal ${cleanName}:`, err.message);
    }
  }

  console.log('\n--- PROCESO COMPLETADO ---');
  console.log(`Canales creados: ${created}`);
  console.log(`Canales actualizados: ${updated}`);
  console.log(`Total procesados: ${RECOVERED_CHANNELS.length}`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
