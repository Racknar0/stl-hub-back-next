import { GoogleGenAI } from '@google/genai';

const LANG_NAMES = { es: 'Spanish', en: 'English' };

// Líneas fijas (bilingües) que el sistema pone alrededor de la descripción de la IA.
// Los STL son de pago: nunca se promete "gratis".
export const CAPTION_HEADER = '🌐 stlgratis com · Premium STL';
export const CAPTION_FOOTER = {
  instagram: '📦 +1MM Premium STL · 🔗 link in bio',
  facebook: '📦 +1MM Premium STL · 🔗 link 👇',
};

/** Caption final de una red: encabezado + descripción de la IA + CTA. */
export function composeCaption(platform, body) {
  const text = String(body || '').trim();
  return text ? `${CAPTION_HEADER}\n\n${text}\n\n${CAPTION_FOOTER[platform]}` : '';
}

/** Quita el encabezado y el CTA fijos para quedarse solo con la descripción. */
export function captionBody(caption) {
  return String(caption || '')
    .replace(CAPTION_HEADER, '')
    .replace(CAPTION_FOOTER.instagram, '')
    .replace(CAPTION_FOOTER.facebook, '')
    .trim();
}

function buildPrompt({ asset, notes, language, withImages, recentBodies = [] }) {
  const lang = LANG_NAMES[language] || 'Spanish';
  return [
    'You are a short-form video copywriter for "STL HUB", a site that SELLS premium 3D printable STL files.',
    'Write the texts for ONE vertical short video (Instagram Reel + Facebook Reel) that showcases ONE 3D model.',
    `Write EVERYTHING in ${lang}.`,
    'Use the ASSET DATA as the source of truth for names (character, franchise).',
    withImages
      ? 'The product images of the model are attached: describe what the model actually looks like (pose, outfit, weapon, base, style).'
      : 'No images are attached: rely on the asset data and the creator notes.',
    '',
    '## STRICT RULES',
    '- The STL files are PAID. NEVER say free, gratis, gratuito, download for free or similar.',
    '- Do NOT write the website, URLs, "link in bio" or any call to action: the system adds a fixed header and footer.',
    '- No hashtags inside the descriptions. No engagement bait ("comment", "tag a friend").',
    '',
    '## instagramBody: SHORT description, 2-3 lines separated by \n, each line starts with ONE fitting emoji.',
    '- Line 1: character + franchise (people search by name).',
    '- Lines 2-3: the most striking visual details and what it is for (resin/FDM, painting, collection). Max ~70 chars per line.',
    '## facebookBody: ONE line (max 120 chars) with 1-2 emojis, different wording from instagramBody.',
    '',
    '## NEVER REPEAT YOURSELF',
    '- Each model is unique: write fresh wording. Do not reuse the openings, phrases, adjectives or emoji sequences of the previous descriptions listed below.',
    '- Avoid generic filler ("cobra vida", "lleno de detalles", "ideal para tu colección", "brings to life") unless it is genuinely the best option.',
    ...(recentBodies.length ? ['PREVIOUS DESCRIPTIONS (do NOT imitate them):', ...recentBodies.map((b, i) => `${i + 1}. ${b.replace(/\n/g, ' / ')}`)] : []),
    '',
    '## subject: what the model is in a few words (e.g. "Squall Leonhart figure").',
    '## hashtags (exactly 5, without #, no spaces, CamelCase): 2 specific (character/franchise), 2 niche (3DPrinting, STLFile), 1 broad.',
    '## youtubeTitle (max 90 chars): name first, then what it is; may end with #Shorts.',
    `## youtubeDescription (2 lines): what the model is + 3 hashtags with #. Last line exactly "${language === 'en' ? 'Get the STL:' : 'Consigue el STL:'}" (the link is appended automatically).`,
    '',
    'Respond ONLY with valid JSON:',
    '{"subject": "...", "instagramBody": "...", "facebookBody": "...", "hashtags": ["..."], "youtubeTitle": "...", "youtubeDescription": "..."}',
    '',
    'ASSET DATA:',
    `- Title: ${asset?.titleEn || asset?.title || 'N/A'}`,
    `- Description: ${(asset?.descriptionEn || asset?.description || 'N/A').slice(0, 800)}`,
    `- Tags: ${asset?.tags?.length ? asset.tags.map(t => t.nameEn || t.name).join(', ') : 'N/A'}`,
    `- Category: ${asset?.categories?.length ? asset.categories.map(c => c.nameEn || c.name).join(', ') : 'N/A'}`,
    `CREATOR NOTES: ${notes?.trim() || 'N/A'}`,
  ].join('\n');
}

// Modo simulado (por defecto): textos fijos de ejemplo, sin llamar a Gemini. Con REELS_AI_MODE=gemini se usa la IA real.
export const isMockAi = () => process.env.REELS_AI_MODE !== 'gemini';

function subjectFrom({ asset, notes, originalName }) {
  if (asset) return asset.titleEn || asset.title;
  if (notes?.trim()) return notes.trim().slice(0, 80);
  return String(originalName || 'Modelo 3D').replace(/\.[^.]+$/, '').replace(/[_\-[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export async function mockReelTexts({ asset, notes, language = 'es', originalName }) {
  await new Promise(r => setTimeout(r, 1500)); // simula el tiempo de análisis
  const subject = subjectFrom({ asset, notes, originalName });
  const es = language !== 'en';
  return {
    subject,
    instagramCaption: composeCaption('instagram', es
      ? `⚔️ ${subject}\n🖨️ Listo para imprimir en resina o FDM\n🎨 Para pintar y exhibir`
      : `⚔️ ${subject}\n🖨️ Ready to print in resin or FDM\n🎨 Made to paint and display`),
    facebookCaption: composeCaption('facebook', es ? `⚔️ ${subject}, listo para imprimir 🖨️` : `⚔️ ${subject}, ready to print 🖨️`),
    hashtags: ['Impresion3D', '3DPrinting', 'STLFile', 'ResinPrint', 'STLHUB'],
    youtubeTitle: `${subject} | STL ${es ? 'para impresión 3D' : '3D Print'} #Shorts`.slice(0, 100),
    youtubeDescription: es
      ? `${subject}, archivo STL listo para imprimir en resina o FDM.\n#Impresion3D #STL #3DPrinting\nConsigue el STL:`
      : `${subject}, STL file ready to print in resin or FDM.\n#3DPrinting #STL #Maker\nGet the STL:`,
    usedImages: 0,
  };
}

/**
 * Genera los textos de un reel con Gemini (uno por red) a partir de los datos del asset
 * y sus imágenes de producto (imageParts: [{ inlineData: { mimeType, data } }]). El video no se envía.
 */
export async function generateReelTexts({ asset, imageParts = [], notes, language = 'es', recentBodies = [] }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey });

  const ask = () => ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [buildPrompt({ asset, notes, language, withImages: imageParts.length > 0, recentBodies }), ...imageParts],
    // Algo más de temperatura para que las descripciones no se parezcan entre sí
    config: { responseMimeType: 'application/json', temperature: 1.1 },
  });

  // Un reintento ante errores de red puntuales
  let response;
  try { response = await ask(); }
  catch (e) {
    console.warn(`[REELS][AI] Reintentando tras error: ${e.message} ${e.cause?.code || ''}`);
    response = await ask();
  }

  const rawText = String(response?.text || '').trim();
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No se pudo leer el resultado de la revisión');
    parsed = JSON.parse(match[0]);
  }

  return {
    subject: String(parsed.subject || '').trim().slice(0, 255),
    instagramCaption: composeCaption('instagram', parsed.instagramBody),
    facebookCaption: composeCaption('facebook', parsed.facebookBody),
    hashtags: (Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map(h => String(h).replace(/[#\s]+/g, '')).filter(Boolean).slice(0, 5),
    youtubeTitle: String(parsed.youtubeTitle || '').trim().slice(0, 100),
    youtubeDescription: String(parsed.youtubeDescription || '').trim(),
    usedImages: imageParts.length,
  };
}

export default { generateReelTexts };
