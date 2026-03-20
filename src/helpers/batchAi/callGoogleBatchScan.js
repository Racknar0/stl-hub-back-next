import fs from 'fs'
import path from 'path'
import util from 'util'
import {
  createPartFromBase64,
  GoogleGenAI,
  PartMediaResolutionLevel,
} from '@google/genai'

const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'
const UPLOADS_DIR = path.resolve('uploads')
const MAX_IMAGES_PER_ITEM = Math.max(1, Number(process.env.BATCH_AI_MAX_IMAGES_PER_ITEM) || 1)
const MAX_IMAGE_BYTES = Math.max(256 * 1024, (Number(process.env.BATCH_AI_MAX_IMAGE_MB) || 4) * 1024 * 1024)
const IMAGE_RESOLUTION_ENV = String(process.env.BATCH_AI_MEDIA_RESOLUTION || 'low').trim().toLowerCase()

function resolveMediaResolutionLevel(raw) {
  if (raw === 'high') return PartMediaResolutionLevel.MEDIA_RESOLUTION_HIGH
  if (raw === 'medium') return PartMediaResolutionLevel.MEDIA_RESOLUTION_MEDIUM
  return PartMediaResolutionLevel.MEDIA_RESOLUTION_LOW
}

const IMAGE_MEDIA_RESOLUTION_LEVEL = resolveMediaResolutionLevel(IMAGE_RESOLUTION_ENV)

const SINGLE_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
   required: ['nombre', 'categoria', 'tags', 'descripcion'],
  properties: {
    nombre: {
      type: 'object',
      additionalProperties: false,
      required: ['es', 'en'],
      properties: {
        es: { type: 'string' },
        en: { type: 'string' },
      },
    },
    categoria: {
      type: 'object',
      additionalProperties: false,
      required: ['es', 'en'],
      properties: {
        es: { type: 'string' },
        en: { type: 'string' },
      },
    },
    tags: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['es', 'en'],
        properties: {
          es: { type: 'string' },
          en: { type: 'string' },
        },
      },
    },
    descripcion: {
      type: 'object',
      additionalProperties: false,
      required: ['es', 'en'],
      properties: {
        es: { type: 'string' },
        en: { type: 'string' },
      },
    },
  },
}

const IMAGE_MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function getImageMimeType(filePath) {
  return IMAGE_MIME_BY_EXT[path.extname(String(filePath || '')).toLowerCase()] || null
}

function getItemDisplayName(item) {
  return String(item?.sourceTitle || item?.assetName || item?.sourcePathHint || item?.itemFolder || 'asset').trim()
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function pickFirstNonEmpty(...values) {
  for (const v of values) {
    const s = String(v || '').trim()
    if (s) return s
  }
  return ''
}

function normalizeTagLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function buildTagCanonicalKey(tag) {
  return (
    slugify(tag?.slug) ||
    slugify(tag?.slugEn) ||
    slugify(tag?.es) ||
    slugify(tag?.en) ||
    slugify(tag?.name) ||
    slugify(tag?.nameEn)
  )
}

function buildCatalogMatchers(payload) {
  const categories = Array.isArray(payload?.dbCatalog?.categories) ? payload.dbCatalog.categories : []
  const tags = Array.isArray(payload?.dbCatalog?.tags) ? payload.dbCatalog.tags : []

  const findCategory = (raw) => {
    const token = normalizeText(raw)
    if (!token) return null
    return categories.find((c) => {
      const candidates = [c?.slug, c?.slugEn, c?.name, c?.nameEn]
      return candidates.some((v) => normalizeText(v) === token)
    }) || null
  }

  const findTag = (raw) => {
    const token = normalizeText(raw)
    if (!token) return null
    return tags.find((t) => {
      const candidates = [t?.slug, t?.slugEn, t?.name, t?.nameEn]
      return candidates.some((v) => normalizeText(v) === token)
    }) || null
  }

  return { findCategory, findTag }
}

function findCatalogTagByRegex(payload, regex) {
  const tags = Array.isArray(payload?.dbCatalog?.tags) ? payload.dbCatalog.tags : []
  return tags.find((t) => {
    const haystack = `${t?.name || ''} ${t?.nameEn || ''} ${t?.slug || ''} ${t?.slugEn || ''}`.toLowerCase()
    return regex.test(haystack)
  }) || null
}

function buildAdultFallbackCategory(payload) {
  const preferred =
    (Array.isArray(payload?.dbCatalog?.adultCategoryCandidates) && payload.dbCatalog.adultCategoryCandidates[0]) ||
    (Array.isArray(payload?.dbCatalog?.categories)
      ? payload.dbCatalog.categories.find((c) => {
          const haystack = `${c?.name || ''} ${c?.nameEn || ''} ${c?.slug || ''} ${c?.slugEn || ''}`.toLowerCase()
          return /(adult|adulto|adultos|nsfw|xxx|erotic|sexual|porn)/i.test(haystack)
        })
      : null)

  if (preferred) {
    return {
      id: preferred.id,
      slug: preferred.slug,
      slugEn: preferred.slugEn || null,
      name: preferred.name,
      nameEn: preferred.nameEn || preferred.name,
      es: preferred.name,
      en: preferred.nameEn || preferred.name,
      fromCatalog: true,
    }
  }

  return {
    slug: 'adultos',
    slugEn: 'adults',
    name: 'Adultos',
    nameEn: 'Adults',
    es: 'Adultos',
    en: 'Adults',
    fromCatalog: false,
  }
}

function buildAdultFallbackResult(payload, item, matchers) {
  const sourceNameEs = pickFirstNonEmpty(item?.sourceTitle, item?.assetName, item?.sourcePathHint, 'asset')
  const sourceNameEn = pickFirstNonEmpty(item?.sourceTitleEn, sourceNameEs)
  const category = buildAdultFallbackCategory(payload)

  const adultTag = findCatalogTagByRegex(payload, /(adult|adulto|adultos|nsfw|xxx|erotic|sexual|porn)/i) || {
    name: 'adultos',
    nameEn: 'adults',
    slug: 'adultos',
    slugEn: 'adults',
  }
  const figureTag = findCatalogTagByRegex(payload, /(figura|figure|figurine|statue|modelo|model)/i) || {
    name: 'figura',
    nameEn: 'figure',
    slug: 'figura',
    slugEn: 'figure',
  }

  const tags = normalizeTags([
    { es: adultTag.name, en: adultTag.nameEn || adultTag.name },
    { es: figureTag.name, en: figureTag.nameEn || figureTag.name },
    { es: 'nsfw', en: 'nsfw' },
  ], matchers)

  return {
    itemId: Number(item?.itemId || 0) || null,
    sourcePathHint: String(item?.sourcePathHint || ''),
    nombre: {
      es: sourceNameEs,
      en: sourceNameEn,
    },
    categoria: category,
    tags,
    descripcion: {
      es: `Modelo STL de ${sourceNameEs} listo para impresion 3D.`,
      en: `STL model of ${sourceNameEn} ready for 3D printing.`,
    },
  }
}

function ensureBilingualName(raw) {
  if (raw && typeof raw === 'object') {
    const es = pickFirstNonEmpty(raw.es, raw.nameEs, raw.nombreEs, raw.nombre, raw.name)
    const en = pickFirstNonEmpty(raw.en, raw.nameEn, raw.nombreEn)
    return {
      es: es || en,
      en: en || es,
    }
  }

  const plain = pickFirstNonEmpty(raw)
  return {
    es: plain,
    en: plain,
  }
}

function ensureBilingualDescription(raw, fallbackEs, fallbackEn) {
  if (raw && typeof raw === 'object') {
    const es = pickFirstNonEmpty(raw.es, raw.descriptionEs, raw.descripcionEs, raw.description)
    const en = pickFirstNonEmpty(raw.en, raw.descriptionEn, raw.descripcionEn)
    const baseEs = pickFirstNonEmpty(fallbackEs, 'No hay descripcion de este producto.')
    const baseEn = pickFirstNonEmpty(fallbackEn, 'No description available for this product.')
    return {
      es: pickFirstNonEmpty(es, en, baseEs),
      en: pickFirstNonEmpty(en, es, baseEn),
    }
  }

  const plain = pickFirstNonEmpty(raw)
  const baseEs = pickFirstNonEmpty(fallbackEs, 'No hay descripcion de este producto.')
  const baseEn = pickFirstNonEmpty(fallbackEn, 'No description available for this product.')
  return {
    es: pickFirstNonEmpty(plain, baseEs),
    en: pickFirstNonEmpty(plain, baseEn),
  }
}

function normalizeCategory(rawCategory, payload, matchers) {
  const bilingual = ensureBilingualName(rawCategory)
  const matched =
    matchers.findCategory(rawCategory?.slug) ||
    matchers.findCategory(bilingual.es) ||
    matchers.findCategory(bilingual.en)

  if (matched) {
    return {
      id: matched.id,
      slug: matched.slug,
      slugEn: matched.slugEn || null,
      name: matched.name,
      nameEn: matched.nameEn || matched.name,
      es: matched.name,
      en: matched.nameEn || matched.name,
      fromCatalog: true,
    }
  }

  const fallbackEs = pickFirstNonEmpty(bilingual.es)
  const fallbackEn = pickFirstNonEmpty(bilingual.en, fallbackEs)
  return {
    slug: slugify(fallbackEn || fallbackEs),
    name: fallbackEs,
    nameEn: fallbackEn,
    es: fallbackEs,
    en: fallbackEn,
    fromCatalog: false,
  }
}

function normalizeTagPair(rawTag, matchers) {
  if (typeof rawTag === 'string') {
    const matched = matchers.findTag(rawTag)
    if (matched) {
      const nameEs = normalizeTagLabel(matched.name)
      const nameEn = normalizeTagLabel(matched.nameEn || matched.name)
      return {
        id: matched.id,
        slug: slugify(matched.slug || nameEn || nameEs) || 'tag',
        slugEn: slugify(matched.slugEn || nameEn || nameEs) || null,
        name: nameEs,
        nameEn: nameEn,
        es: nameEs,
        en: nameEn,
        fromCatalog: true,
        iaSuggested: true,
      }
    }

    const clean = normalizeTagLabel(pickFirstNonEmpty(rawTag))
    return {
      slug: slugify(clean),
      name: clean,
      nameEn: clean,
      es: clean,
      en: clean,
      fromCatalog: false,
      iaSuggested: true,
    }
  }

  const pair = ensureBilingualName(rawTag)
  const matched =
    matchers.findTag(rawTag?.slug) ||
    matchers.findTag(pair.es) ||
    matchers.findTag(pair.en)

  if (matched) {
    const nameEs = normalizeTagLabel(matched.name)
    const nameEn = normalizeTagLabel(matched.nameEn || matched.name)
    return {
      id: matched.id,
      slug: slugify(matched.slug || nameEn || nameEs) || 'tag',
      slugEn: slugify(matched.slugEn || nameEn || nameEs) || null,
      name: nameEs,
      nameEn: nameEn,
      es: nameEs,
      en: nameEn,
      fromCatalog: true,
      iaSuggested: true,
    }
  }

  const es = normalizeTagLabel(pickFirstNonEmpty(pair.es, pair.en))
  const en = normalizeTagLabel(pickFirstNonEmpty(pair.en, pair.es))
  return {
    slug: slugify(en || es),
    name: es,
    nameEn: en,
    es,
    en,
    fromCatalog: false,
    iaSuggested: true,
  }
}

function normalizeTags(rawTags, matchers) {
  const values = Array.isArray(rawTags) ? rawTags : []
  const normalized = []
  const seen = new Set()

  for (const rawTag of values) {
    const tag = normalizeTagPair(rawTag, matchers)
    const key = buildTagCanonicalKey(tag)
    if (!key || seen.has(key)) continue
    seen.add(key)
    normalized.push(tag)
    if (normalized.length >= 3) break
  }

  while (normalized.length < 3) {
    const fallbackName = `tag-${normalized.length + 1}`
    normalized.push({
      slug: fallbackName,
      name: fallbackName,
      nameEn: fallbackName,
      es: fallbackName,
      en: fallbackName,
      fromCatalog: false,
      iaSuggested: true,
    })
  }

  return normalized.slice(0, 3)
}

function sanitizeItemForPrompt(item) {
  if (!item || typeof item !== 'object') return {}
  const { imagePaths, ...rest } = item
  return rest
}

function buildSingleItemPromptPayload(payload, item, attachedImages) {
  return {
    domainContext: payload?.domainContext || {},
    dbCatalog: payload?.dbCatalog || {},
    scanItem: sanitizeItemForPrompt(item),
    visualContext: {
      attachedImages,
      maxImagesPerItem: MAX_IMAGES_PER_ITEM,
      mediaResolution: IMAGE_RESOLUTION_ENV,
    },
  }
}

async function buildImagePartsForItem(item) {
  const imagePaths = Array.isArray(item?.imagePaths)
    ? item.imagePaths.map((img) => String(img || '').trim()).filter(Boolean)
    : []

  const uniqueImagePaths = [...new Set(imagePaths)]
  const parts = []
  let attachedImages = 0

  for (const relativeImagePath of uniqueImagePaths) {
    if (attachedImages >= MAX_IMAGES_PER_ITEM) break

    const absoluteImagePath = path.join(UPLOADS_DIR, relativeImagePath)
    const mimeType = getImageMimeType(absoluteImagePath)
    if (!mimeType || !fs.existsSync(absoluteImagePath)) {
      continue
    }

    let fileStat
    try {
      fileStat = fs.statSync(absoluteImagePath)
    } catch {
      continue
    }

    if (!fileStat.isFile() || fileStat.size <= 0 || fileStat.size > MAX_IMAGE_BYTES) {
      continue
    }

    try {
      const base64Data = fs.readFileSync(absoluteImagePath).toString('base64')
      parts.push(
        createPartFromBase64(
          base64Data,
          mimeType,
          IMAGE_MEDIA_RESOLUTION_LEVEL,
        ),
      )
      attachedImages += 1
    } catch (error) {
      console.warn('[BATCH][AI][IMAGE_WARN]', getItemDisplayName(item), error?.message || error)
    }
  }

  return { parts, attachedImages }
}

function extractJsonFromText(rawText) {
  const txt = String(rawText || '').trim()
  if (!txt) return null

  try { return JSON.parse(txt) } catch {}

  const fenced = txt.match(/```json\s*([\s\S]*?)```/i) || txt.match(/```\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    try { return JSON.parse(fenced[1].trim()) } catch {}
  }

  const firstBrace = txt.indexOf('{')
  const lastBrace = txt.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = txt.slice(firstBrace, lastBrace + 1)
    try { return JSON.parse(candidate) } catch {}
  }

  const firstBracket = txt.indexOf('[')
  const lastBracket = txt.lastIndexOf(']')
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    const candidate = txt.slice(firstBracket, lastBracket + 1)
    try { return JSON.parse(candidate) } catch {}
  }

  return null
}

function normalizeListShape(parsed) {
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && (parsed.nombre || parsed.name || parsed.sourceTitle)
      ? [parsed]
      : Array.isArray(parsed?.items)
        ? parsed.items
        : []

  return arr
    .map((item) => {
      const nombre = item?.nombre || {
        es: pickFirstNonEmpty(item?.nombreEs, item?.nameEs, item?.name, item?.sourceTitle),
        en: pickFirstNonEmpty(item?.nombreEn, item?.nameEn),
      }
      const categoria = item?.categoria || item?.category || {}

      const rawTags = Array.isArray(item?.tags)
        ? item.tags
        : typeof item?.tags === 'string'
          ? item.tags.split(',')
          : Array.isArray(item?.suggestedExistingTagSlugs)
            ? item.suggestedExistingTagSlugs
            : []

      const descripcion = item?.descripcion || item?.description || {
        es: pickFirstNonEmpty(item?.descripcionEs, item?.descriptionEs),
        en: pickFirstNonEmpty(item?.descripcionEn, item?.descriptionEn),
      }

      return { nombre, categoria, tags: rawTags, descripcion }
    })
    .filter((x) => pickFirstNonEmpty(x?.nombre?.es, x?.nombre?.en))
}

function toDebugText(value) {
  return util.inspect(value, { depth: 6, breakLength: 120, maxArrayLength: 50 })
}

async function classifySingleItem(ai, payload, item) {
  const matchers = buildCatalogMatchers(payload)
  const { parts: imageParts, attachedImages } = await buildImagePartsForItem(item)
  const promptPayload = buildSingleItemPromptPayload(payload, item, attachedImages)

  const prompt = [
    'Eres un asistente para clasificacion de assets de tienda STL.',
    'Recibiras UN solo asset y, cuando esten disponibles, imagenes reales adjuntas del asset.',
    'Debes analizar primero las imagenes adjuntas para clasificarlo.',
    'Si las imagenes son ambiguas, insuficientes o no estan presentes, usa como respaldo assetName, sourceTitle y sourcePathHint.',
    'El dominio es una tienda de renders/modelos 3D.',
    'Si el contenido muestra desnudez explicita, sexualidad evidente o una tematica NSFW, debes usar una categoria adulta existente del catalogo si esta disponible.',
    'Debes elegir SOLO 1 categoria del catalogo recibido.',
    'Debes devolver EXACTAMENTE 3 tags.',
    'IMPORTANTE: cada tag debe venir como par bilingue { es, en }.',
    'Si un tag equivalente ya existe en el catalogo en espanol o en ingles, devuelve exactamente ese mismo par es/en del catalogo.',
    'Si realmente no existe equivalente en el catalogo, propone tag nuevo tambien en formato bilingue (es/en).',
    'El nombre del asset debe devolverse SIEMPRE bilingue en el objeto nombre: { es, en }.',
    'La categoria debe devolverse SIEMPRE bilingue en el objeto categoria: { es, en }.',
    'La descripcion debe devolverse SIEMPRE bilingue en el objeto descripcion: { es, en }.',
    'Responde SOLO JSON valido, sin markdown ni texto extra, usando EXACTAMENTE esta forma:',
    JSON.stringify({
      nombre: { es: 'figura anime samurai', en: 'samurai anime figure' },
      categoria: { es: 'Anime', en: 'Anime' },
      tags: [
        { es: 'samurai', en: 'samurai' },
        { es: 'katana', en: 'katana' },
        { es: 'fantasia', en: 'fantasy' },
      ],
      descripcion: {
        es: 'Figura anime samurai lista para impresion 3D, ideal para coleccionistas y vitrinas tematicas.',
        en: 'Samurai anime figure ready for 3D printing, ideal for collectors and themed display shelves.',
      },
    }, null, 2),
    'Contexto JSON del asset:',
    JSON.stringify(promptPayload, null, 2),
  ].join('\n\n')

  console.log('[BATCH][AI][INPUT]', {
    item: getItemDisplayName(item),
    attachedImages,
    availableImages: Number(item?.imagesCount || 0),
  })

  const response = await ai.models.generateContent({
    model: MODEL_NAME,
    contents: [prompt, ...imageParts],
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: SINGLE_RESULT_SCHEMA,
    },
  })

  const parsed = extractJsonFromText(response?.text)
  if (!parsed) {
    const rawResponseText = String(response?.text || '').trim()
    console.error('[BATCH][AI][PARSE_ERROR] No se pudo parsear JSON para', getItemDisplayName(item))
    console.error('[BATCH][AI][PARSE_ERROR][RAW_RESPONSE]', rawResponseText || toDebugText(response))
    console.warn('[BATCH][AI][FALLBACK] Aplicando categoria/tag de adultos por parse fallido en', getItemDisplayName(item))
    return [buildAdultFallbackResult(payload, item, matchers)]
  }

  const normalized = normalizeListShape(parsed)
  if (!normalized.length) {
    console.warn('[BATCH][AI][FALLBACK] Respuesta vacia/no usable, aplicando adultos en', getItemDisplayName(item))
    return [buildAdultFallbackResult(payload, item, matchers)]
  }

  return normalized.map((entry) => {
    const namePair = ensureBilingualName(entry?.nombre)
    const category = normalizeCategory(entry?.categoria, payload, matchers)
    const tags = normalizeTags(entry?.tags, matchers)
    const descriptionPair = ensureBilingualDescription(
      entry?.descripcion,
      `Modelo STL de ${namePair.es}.`,
      `STL model of ${namePair.en}.`,
    )

    return {
      itemId: Number(item?.itemId || 0) || null,
      sourcePathHint: String(item?.sourcePathHint || ''),
      nombre: {
        es: namePair.es,
        en: namePair.en,
      },
      categoria: category,
      tags,
      descripcion: {
        es: descriptionPair.es,
        en: descriptionPair.en,
      },
    }
  })
}

export async function callGoogleBatchScan(payload) {
  try {
    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
    if (!apiKey) {
      console.warn('[BATCH][AI][WARN] GEMINI_API_KEY no configurada')
      return []
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        apiVersion: 'v1alpha',
      },
    })

    const scannedItems = Array.isArray(payload?.scanContext?.scannedItems)
      ? payload.scanContext.scannedItems
      : []

    console.info(`[BATCH][AI][START] items=${scannedItems.length} model=${MODEL_NAME}`)

    const normalized = []
    let done = 0
    for (const item of scannedItems) {
      const total = scannedItems.length || 1
      const startPct = Math.round((done / total) * 100)
      console.info(`[BATCH][AI][PROGRESS] ${startPct}% (${done}/${total}) procesando "${getItemDisplayName(item)}"`)
      try {
        const result = await classifySingleItem(ai, payload, item)
        normalized.push(...result)
      } catch (error) {
        console.error('[BATCH][AI][ITEM_ERROR]', getItemDisplayName(item), error?.message || error)
        console.error('[BATCH][AI][ITEM_ERROR][DETAIL]', toDebugText(error))
      } finally {
        done += 1
        const endPct = Math.round((done / total) * 100)
        console.info(`[BATCH][AI][PROGRESS] ${endPct}% (${done}/${total})`)
      }
    }

    // Evento JSON para que el front lo pueda formatear de forma legible por item.
    console.log('[BATCH][AI][RESULT_JSON]', JSON.stringify(normalized))

    console.info(`[BATCH][AI][DONE] itemsProcesados=${done}/${scannedItems.length || 0} sugerencias=${normalized.length}`)

    return normalized
  } catch (error) {
    console.error('[BATCH][AI][ERROR]', error?.message || error)
    console.error('[BATCH][AI][ERROR][DETAIL]', toDebugText(error))
    return []
  }
}
