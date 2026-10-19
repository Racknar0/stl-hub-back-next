import { GoogleGenAI } from '@google/genai';
import { FORBIDDEN_KEYWORDS, sanitizePinVariation } from '../utils/pinterestForbiddenWords.js';

// Niveles de la revisión de imagen y cuándo se descarta (criterio acordado para Pinterest):
// sexual y odio se descartan desde "mild"; violencia y armas reales solo si son "strong".
const LEVELS = ['none', 'mild', 'strong'];
const REJECT_FROM = { sexual: 'mild', hate: 'mild', violence: 'strong', realWeapons: 'strong' };
const REASON_LABELS = { sexual: 'contenido sexual', hate: 'símbolos de odio', violence: 'violencia explícita', realWeapons: 'armas reales' };

const normalizeLevel = (v) => (LEVELS.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : 'strong');

export function evaluateImageReview(review) {
  if (!review || typeof review !== 'object') {
    return { ok: false, scores: null, reason: 'La IA no devolvió la revisión de la imagen' };
  }
  // Ante la duda (valor ausente o raro) se toma el nivel más alto
  const scores = Object.fromEntries(Object.keys(REJECT_FROM).map(k => [k, normalizeLevel(review[k])]));
  const failed = Object.keys(REJECT_FROM).filter(k => LEVELS.indexOf(scores[k]) >= LEVELS.indexOf(REJECT_FROM[k]));
  if (failed.length === 0) return { ok: true, scores, reason: null };
  const detail = String(review.reason || '').trim().slice(0, 160);
  const labels = failed.map(k => `${REASON_LABELS[k]} (${scores[k]})`).join(', ');
  return { ok: false, scores, reason: detail ? `${labels}: ${detail}` : labels };
}

const IMAGE_REVIEW_RULES = [
  '## STEP 1 - IMAGE SAFETY REVIEW FOR PINTEREST (do this first):',
  'Rate the attached image in 4 categories with "none", "mild" or "strong". When unsure, choose the HIGHER level.',
  '- sexual: nudity or partial nudity (even covered by hair or hands), lingerie, bikini, erotic poses, emphasis on breasts or buttocks, "sexy waifu" style figures. Normal clothing, armor or superhero suits = none.',
  '- violence: blood, gore, dismemberment, guts, torture, decapitation. Skulls, skeletons, zombies, monsters, Halloween, villains and fights without blood = none or mild.',
  '- realWeapons: realistic firearms or firearm parts (pistols, rifles, magazines, receivers). Swords, axes, fantasy, cosplay or video game weapons and obvious toy guns = none.',
  '- hate: swastikas, nazi or hate group symbols, racist caricatures. Historical uniforms or vehicles without such symbols = none.',
  'Watermarks, URLs, logos, background or image quality do NOT matter.',
  'If sexual or hate is "mild" or "strong", or violence or realWeapons is "strong", return EMPTY pinTitle, pinDescription and pinHashtags (do not write the pin).',
  '',
].join('\n');

function buildPrompt({ title, description, tags, category, count, trendKeyword, reviewImage }) {
  let trendInstruction = '';
  if (trendKeyword && String(trendKeyword).trim()) {
    const cleanTrend = String(trendKeyword).trim();
    trendInstruction = [
      '',
      '## CRITICAL PIN REGULATION - PINTEREST TREND MATCHING:',
      `- Pinterest is currently experiencing high search volume for: "${cleanTrend}".`,
      '- You MUST intelligently and creatively adapt the title and description to align this 3D model with this trend keyword, making a logical connection.',
      `- The phrase "${cleanTrend}" MUST appear naturally within the pinTitle and within the pinDescription (without forcing it or looking like spam).`,
      `- Add the hashtag "${cleanTrend.replace(/\s+/g, '')}" as one of the first elements in pinHashtags.`,
      '',
    ].join('\n');
  }

  const pinShape = '"pinTitle": "...", "pinDescription": "...", "pinHashtags": ["..."]';
  const reviewShape = '"imageReview": {"sexual": "none|mild|strong", "violence": "none|mild|strong", "realWeapons": "none|mild|strong", "hate": "none|mild|strong", "reason": "short explanation"}';
  let responseShape;
  if (reviewImage) responseShape = `{${reviewShape}, ${pinShape}}`;
  else responseShape = count === 1 ? `{${pinShape}}` : `{"variations": [{${pinShape}}, ...]}`;

  return [
    'You are a Pinterest SEO expert for "STL HUB", a store selling 3D printable STL files.',
    reviewImage ? IMAGE_REVIEW_RULES : '',
    reviewImage ? '## STEP 2 - WRITE THE PIN (only if the image passed step 1):' : '',
    `Generate EXACTLY ${count} UNIQUE variation(s). Each MUST have different wording and keyword order.`,
    trendInstruction,
    '',
    '## RULES FOR pinTitle (max 100 chars):',
    '- ALWAYS identify the CHARACTER/SUBJECT name from the title — this is the STAR of the pin',
    '- Pattern: "[Character Name] [Pose/Style] 3D Print STL | [Franchise/Use]"',
    '- Put the recognizable name FIRST — people search by character, not by "3D Print"',
    '- If it\'s from a franchise (Marvel, Anime, DC, etc.), include the franchise name',
    '- NEVER start with "3D Print STL File:" — that\'s boring and wastes title space',
    '- NEVER use "Download Now!" or clickbait CTAs in the title',
    '- Each variation should emphasize a different angle (character, franchise, use case)',
    '',
    'GOOD title examples:',
    '  "Venom Marvel Figure STL File | 3D Printable Collectible"',
    '  "Goku Ultra Instinct 3D Print STL | Dragon Ball Z Figure"',
    '  "Batman Arkham Knight Bust STL | DC Comics 3D Model"',
    '  "Mandalorian Helmet 3D Print File | Star Wars Cosplay STL"',
    '  "Pikachu Planter STL File | Pokémon 3D Print Desk Decor"',
    '',
    'BAD titles (DO NOT generate these):',
    '  "3D Print STL File: Cool Character - Download Now!"',
    '  "Amazing STL Download | 3D Printable Model Free"',
    '  "Best 3D Print Figure STL File For Your Collection"',
    '',
    '## RULES FOR pinDescription (250-400 chars):',
    '- Start with what the model IS, not generic filler',
    '- Write like a collector recommending to a friend, not a robot',
    '- Mention specific details: pose, size potential, print type (resin/FDM)',
    '- Include ONE soft CTA at the end: "Perfect for...", "Add it to your collection"',
    '- NEVER use hashtags in the description',
    '- NEVER repeat the exact title in the description',
    '',
    '## RULES FOR pinHashtags (exactly 20):',
    '- Array of 20 strings WITHOUT # symbol',
    '- NEVER use spaces in hashtags — use CamelCase: "CasualAthlete" NOT "Casual Athlete"',
    '- First 5: ultra-specific (character name, franchise, pose)',
    '- Next 5: niche (AnimeFigure, MarvelCollectible, etc.)',
    '- Next 5: medium (3Dprinting, STLfile, ResinPrint, FDM)',
    '- Last 5: broad (Maker, DIY, Collectible, HomeDecor, GeekGifts)',
    '- Vary slightly between variations',
    '',
    '## FORBIDDEN WORDS (Pinterest will reject the pin):',
    `- NEVER use these words anywhere (title, description or hashtags), not even inside other words: ${FORBIDDEN_KEYWORDS.join(', ')}`,
    '- For attractive or stylized characters use neutral words like "stylish", "elegant", "detailed", "dynamic pose"',
    '',
    'Respond ONLY with valid JSON:',
    responseShape,
    '',
    'ASSET DATA:',
    `- Title: ${title}`,
    `- Description: ${description || 'N/A'}`,
    `- Tags: ${Array.isArray(tags) ? tags.join(', ') : 'N/A'}`,
    `- Category: ${category || 'General'}`,
  ].join('\n');
}

/**
 * Genera el texto SEO del pin con Gemini. Con reviewImage=true pide además la revisión de seguridad
 * de la imagen en la misma llamada (una sola variación) y devuelve { variations, review }.
 */
export async function generatePinVariations({ title, description, tags, category, imageParts = [], count = 1, trendKeyword, reviewImage = false }) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');
  const ai = new GoogleGenAI({ apiKey });
  const n = reviewImage ? 1 : Math.min(Math.max(1, parseInt(count) || 1), 15);

  const response = await ai.models.generateContent({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    contents: [buildPrompt({ title, description, tags, category, count: n, trendKeyword, reviewImage }), ...imageParts],
    config: { responseMimeType: 'application/json' },
  });

  const rawText = String(response?.text || '').trim();
  let parsed;
  try { parsed = JSON.parse(rawText); }
  catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Could not parse AI response');
  }

  const review = reviewImage ? evaluateImageReview(parsed.imageReview) : null;

  // Normalize: always return variations array
  const rawVariations = (n === 1 && !parsed.variations) ? [parsed] : (parsed.variations || [parsed]);
  // Quitar palabras prohibidas sin regenerar (evita que /schedule rechace el pin)
  const variations = rawVariations.map(v => {
    const { variation, removed } = sanitizePinVariation({
      pinTitle: v.pinTitle || (reviewImage ? '' : title),
      pinDescription: v.pinDescription || (reviewImage ? '' : description),
      pinHashtags: Array.isArray(v.pinHashtags) ? v.pinHashtags.slice(0, 20).map(h => String(h).replace(/\s+/g, '')) : [],
    });
    if (removed.length > 0) console.warn(`[PINTEREST][AI] Palabras prohibidas eliminadas: ${removed.join(', ')}`);
    return variation;
  });

  return { variations, review };
}

export default { generatePinVariations, evaluateImageReview };
