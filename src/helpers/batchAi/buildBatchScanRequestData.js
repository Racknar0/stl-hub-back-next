export function buildBatchScanRequestData(req, context = {}, catalogs = {}) {
  const ctx = context || {}
  const scannedItems = Array.isArray(ctx.scannedItems) ? ctx.scannedItems : []
  const categories = Array.isArray(catalogs?.categories)
    ? catalogs.categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        nameEn: c.nameEn || null,
        slugEn: c.slugEn || null,
      }))
    : []
  const tags = Array.isArray(catalogs?.tags)
    ? catalogs.tags.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        nameEn: t.nameEn || null,
        slugEn: t.slugEn || null,
      }))
    : []
  const adultCategoryCandidates = categories.filter((c) => {
    const haystack = `${c.name || ''} ${c.slug || ''} ${c.nameEn || ''} ${c.slugEn || ''}`.toLowerCase()
    return /(adult|adulto|adultos|nsfw|xxx|erotic|erotico|erotica|sexual|porn)/i.test(haystack)
  })

  return {
    domainContext: {
      productType: 'renders_figuras_3d',
      safety: 'No hay contenido adulto real; solo renders/modelos de figuras 3D.',
      moderationRule: 'Si el asset representa desnudez explícita o temática sexual, debe caer en la categoría adulta del catálogo si existe.',
    },
    scanContext: {
      foldersCount: Number(ctx.foldersCount || 0),
      newlyQueuedCount: Number(ctx.newlyQueuedCount || 0),
      scannedItems,
    },
    dbCatalog: {
      categories,
      tags,
      adultCategoryCandidates,
    },
    requestedAt: new Date().toISOString(),
  }
}
