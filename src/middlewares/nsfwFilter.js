import jwt from 'jsonwebtoken'

/**
 * Middleware: intenta leer JWT del header Authorization sin rechazar.
 * - Token válido  → req.user = payload
 * - Sin token / inválido → req.user = null  (NO devuelve 401)
 */
export const optionalAuth = (req, _res, next) => {
  try {
    const auth = req.headers.authorization || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
    if (token) {
      const secret = process.env.JWT_SECRET || 'dev-secret'
      req.user = jwt.verify(token, secret)
    } else {
      req.user = null
    }
  } catch {
    req.user = null
  }
  next()
}

/**
 * Palabras clave que indican contenido NSFW.
 * El filtro hace `contains` parcial contra slug de categorías y tags.
 */
const NSFW_KEYWORDS = [
  'adult', '18', 'nsfw', 'hentai', 'sexy', 'erotic', 'erotica', 'desnud', 'gore', 'xxx', 'porn', 'r18', 'fetish', 'fetis', 'bdsm', 'bondage',
  'bikini', 'bunny-girl', 'bunnygirl', 'pin-up', 'pinup', 'sensual', 'waifu', 'lenceria', 'lingerie', 'nude', 'naked', 'panties', 'topless', 'conejita', 'playboy', 'stripper', 'swimsuit', 'swimwear', 'tanga', 'hilo-dental', 'hilo dental', 'sin-ropa', 'sin ropa',
  'seductor', 'seductora', 'provocativ', 'boudoir', 'boobs', 'buttocks', 'trasero', 'nalgas', 'gluteos', 'underboob', 'cleavage', 'escote', 'pezon', 'pezones', 'nipple', 'nipples', 'caliente',
  '3dxm', 'jigglystix', 'digital-dark-pinups',
  // Armas, réplicas y cosplay militar/táctico
  'arma', 'weapon', 'gun', 'bullet', 'firearm', 'ammo', 'ammunition', 'granada', 'grenade', 'shotgun', 'escopeta', 
  'rifle', 'fusil', 'revolver', 'pistola', 'pistol', 'ak47', 'glock', 'carbine', 'm870', 'remington', 'colt', 
  'mauser', 'submachine', 'silenciador', 'silencer', 'balas', 'municion', 'katana', 'sword', 'espada', 'cuchillo', 
  'knife', 'knives', 'blade', 'hacha', 'axe', 'shield', 'escudo', 'bayoneta', 'bayonet', 'tactico', 'tactical',
  // Tabaco y accesorios para fumar
  'cenicero', 'ashtray', 'smoke', 'fumar', 'weed', 'marihuana', 'cigarro', 'cigarrillo', 'tabaco', 'tobacco',
  // Violencia, sangre y muerte
  'gore', 'sangre', 'blood', 'kill', 'muerte', 'death', 'esqueleto', 'skeleton', 'craneo', 'skull'
]

/**
 * Construye condiciones Prisma `where` para excluir assets NSFW.
 * - Usuario logueado  → devuelve {} (sin filtro)
 * - Anónimo           → excluye assets cuya categoría, tag (slug O name), título o slug contenga alguna keyword
 *
 * Uso: const nsfwWhere = buildNsfwWhere(req);
 *      prisma.asset.findMany({ where: { status: 'PUBLISHED', ...nsfwWhere } })
 */
export function buildNsfwWhere(req) {
  if (req?.user) return {}

  // Filtros por slug (para categorías y tags)
  const kwSlugFilters = NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } }))

  // Filtros extendidos para tags: slug, name Y nameEn (cierra brecha slug="calavera" vs name="Cráneo")
  const kwTagFilters = NSFW_KEYWORDS.flatMap(kw => [
    { slug:   { contains: kw } },
    { name:   { contains: kw } },
    { nameEn: { contains: kw } },
  ])

  return {
    AND: [
      { categories: { none: { OR: kwSlugFilters } } },
      { tags:       { none: { OR: kwTagFilters  } } },
      {
        NOT: {
          OR: [
            ...NSFW_KEYWORDS.map(kw => ({ title: { contains: kw } })),
            ...NSFW_KEYWORDS.map(kw => ({ slug:  { contains: kw } }))
          ]
        }
      }
    ],
  }
}


/**
 * Construye condiciones Prisma para excluir categorías NSFW del listado público.
 * - Usuario logueado  → devuelve {} (sin filtro)
 * - Anónimo           → NOT slug contiene alguna keyword
 */
export function buildNsfwCategoryWhere(req) {
  if (req?.user) return {}

  return {
    NOT: {
      OR: NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } })),
    },
  }
}

/**
 * Construye condiciones Prisma para excluir tags NSFW del listado público.
 * Misma lógica que categorías pero para la tabla tag.
 */
export function buildNsfwTagWhere(req) {
  if (req?.user) return {}

  return {
    NOT: {
      OR: NSFW_KEYWORDS.map(kw => ({ slug: { contains: kw } })),
    },
  }
}

/**
 * Verifica si un asset (con sus relaciones cargadas) es NSFW.
 * Espera que el asset tenga { categories: [{ slug }], tags: [{ slug }] }
 */
export function isAssetNSFW(asset) {
  if (!asset) return false
  const title = String(asset.title || '').toLowerCase()
  const slug = String(asset.slug || '').toLowerCase()
  const matchesKeyword = (str) => NSFW_KEYWORDS.some(kw => str.includes(kw))

  if (matchesKeyword(title) || matchesKeyword(slug)) return true

  const check = (arr) => {
    if (!Array.isArray(arr)) return false
    return arr.some(item => {
      const s = String(item?.slug || '').toLowerCase()
      return NSFW_KEYWORDS.some(kw => s.includes(kw))
    })
  }
  return check(asset.categories) || check(asset.tags)
}

export { NSFW_KEYWORDS }
