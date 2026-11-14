const MB = 1024 * 1024;

export function assetSizeFilter(query) {
  const parse = value => {
    if (value === undefined || value === null || String(value).trim() === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number * MB > Number.MAX_SAFE_INTEGER) throw new RangeError('El tamaño debe ser un número válido mayor o igual a cero.');
    return number;
  };
  const min = parse(query.minSizeMB);
  const max = parse(query.maxSizeMB);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && min > max) throw new RangeError('El tamaño mínimo no puede superar el máximo.');
  const range = {};
  if (min !== null) range.gte = BigInt(Math.ceil(min * MB));
  if (max !== null) range.lte = BigInt(Math.floor(max * MB));
  // Match the size displayed in the table: fileSizeB, falling back to archiveSizeB.
  return { OR: [{ fileSizeB: range }, { fileSizeB: null, archiveSizeB: range }] };
}
