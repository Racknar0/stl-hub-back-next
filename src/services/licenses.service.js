/**
 * licenses.service.js — Servidor de licencias para programas de escritorio.
 *
 * Reglas:
 *  - Cada serial pertenece a un producto y admite UNA instalación. Repetir desde la misma
 *    instalación es idempotente; desde otra se rechaza.
 *  - La activación es atómica: un UPDATE condicionado a installationId IS NULL. Si dos
 *    instalaciones llegan a la vez, MySQL bloquea la fila y solo una actualiza.
 *  - Los errores de serial inexistente / de otro producto / producto inexistente son idénticos.
 */
import { PrismaClient } from '@prisma/client';
import {
  generateSerial, normalizeSerial, hashSerial, maskSerial,
  loadSigningKeys, signLicense, verifyLicense, LICENSE_ISSUER,
} from '../utils/licenseCrypto.js';

export const LICENSE_DAYS = 30;
const PRODUCT_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const INSTALLATION_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export class LicenseError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const INVALID_SERIAL = () => new LicenseError(404, 'invalid_serial', 'Serial no válido para este producto');
const badRequest = (message) => new LicenseError(400, 'invalid_request', message);

export const isValidProductId = (v) => typeof v === 'string' && PRODUCT_RE.test(v);
export const isValidInstallationId = (v) => typeof v === 'string' && INSTALLATION_RE.test(v);

const REASON_MESSAGES = {
  revoked: 'La licencia fue revocada',
  activation_released: 'La activación fue liberada; vuelve a activar el serial',
  installation_mismatch: 'La licencia pertenece a otra instalación',
  product_mismatch: 'La licencia pertenece a otro producto',
  product_disabled: 'El producto está desactivado',
  invalid_license: 'Licencia no válida',
};

export function serialStatus(row) {
  if (row.revokedAt) return 'revoked';
  if (row.installationId) return 'active';
  return 'unused';
}

export function createLicenseService({ prisma, now = () => new Date(), getKeys = () => loadSigningKeys() }) {
  const requireKeys = () => {
    const keys = getKeys();
    if (!keys) throw new LicenseError(503, 'licensing_unavailable', 'Servidor de licencias no configurado');
    return keys;
  };

  const issue = (keys, row, productCode, installationId) => {
    const iat = Math.floor(now().getTime() / 1000);
    const exp = iat + LICENSE_DAYS * 24 * 60 * 60;
    const license = signLicense({ iss: LICENSE_ISSUER, sub: String(row.id), pid: productCode, iid: installationId, iat, exp }, keys);
    return { license, expires_at: new Date(exp * 1000).toISOString() };
  };

  // ─── Público ─────────────────────────────────────────────────────
  async function activate({ product_id, serial, installation_id }) {
    if (!isValidProductId(product_id)) throw badRequest('product_id inválido');
    if (!isValidInstallationId(installation_id)) throw badRequest('installation_id inválido (8-128 caracteres: letras, números, . _ : -)');
    if (typeof serial !== 'string' || !serial.trim()) throw badRequest('serial requerido');
    const keys = requireKeys();

    const normalized = normalizeSerial(serial);
    if (!normalized) throw INVALID_SERIAL();
    const row = await prisma.licenseSerial.findUnique({ where: { serialHash: hashSerial(normalized) }, include: { product: true } });
    if (!row || row.product.code !== product_id || !row.product.active) throw INVALID_SERIAL();
    if (row.revokedAt) throw new LicenseError(403, 'revoked', 'El serial fue revocado');

    const at = now();
    // Canje atómico: solo gana quien encuentra la fila libre
    const claimed = await prisma.licenseSerial.updateMany({
      where: { id: row.id, installationId: null, revokedAt: null },
      data: { installationId: installation_id, activatedAt: at, lastValidatedAt: at },
    });

    let activatedAt = at;
    if (claimed.count !== 1) {
      const fresh = await prisma.licenseSerial.findUnique({ where: { id: row.id } });
      if (!fresh || fresh.revokedAt) throw new LicenseError(403, 'revoked', 'El serial fue revocado');
      if (fresh.installationId !== installation_id) {
        throw new LicenseError(409, 'already_activated', 'El serial ya está activado en otra instalación');
      }
      // Misma instalación: idempotente
      activatedAt = fresh.activatedAt || at;
      await prisma.licenseSerial.update({ where: { id: row.id }, data: { lastValidatedAt: at } });
    }

    return {
      valid: true,
      ...issue(keys, row, product_id, installation_id),
      product_id,
      installation_id,
      activated_at: activatedAt.toISOString(),
    };
  }

  async function validate({ product_id, installation_id, license }) {
    if (!isValidProductId(product_id)) throw badRequest('product_id inválido');
    if (!isValidInstallationId(installation_id)) throw badRequest('installation_id inválido');
    if (typeof license !== 'string' || !license) throw badRequest('license requerida');
    const keys = requireKeys();
    const invalid = (reason) => ({ valid: false, reason, message: REASON_MESSAGES[reason] });

    const payload = verifyLicense(license, keys);
    if (!payload) return invalid('invalid_license');
    if (payload.pid !== product_id) return invalid('product_mismatch');
    if (payload.iid !== installation_id) return invalid('installation_mismatch');

    const id = Number(payload.sub);
    if (!Number.isInteger(id) || id <= 0) return invalid('invalid_license');
    const row = await prisma.licenseSerial.findUnique({ where: { id }, include: { product: true } });
    if (!row || row.product.code !== product_id) return invalid('invalid_license');
    if (!row.product.active) return invalid('product_disabled');
    if (row.revokedAt) return invalid('revoked');
    if (!row.installationId) return invalid('activation_released');
    if (row.installationId !== installation_id) return invalid('installation_mismatch');

    await prisma.licenseSerial.update({ where: { id }, data: { lastValidatedAt: now() } });
    return { valid: true, ...issue(keys, row, product_id, installation_id) };
  }

  // ─── Administración ──────────────────────────────────────────────
  const toAdmin = (row) => ({
    id: row.id,
    product_id: row.product?.code,
    product_name: row.product?.name,
    masked: row.masked,
    status: serialStatus(row),
    note: row.note,
    installation_id: row.installationId,
    activated_at: row.activatedAt,
    last_validated_at: row.lastValidatedAt,
    reset_count: row.resetCount,
    revoked_at: row.revokedAt,
    revoke_reason: row.revokeReason,
    created_at: row.createdAt,
  });

  const getSerialRow = async (id) => {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw badRequest('id inválido');
    const row = await prisma.licenseSerial.findUnique({ where: { id: n }, include: { product: true } });
    if (!row) throw new LicenseError(404, 'not_found', 'Serial no encontrado');
    return row;
  };

  async function listProducts() {
    const products = await prisma.licenseProduct.findMany({ orderBy: { createdAt: 'asc' } });
    const counts = await prisma.licenseSerial.groupBy({
      by: ['productId'],
      _count: { _all: true },
    });
    const active = await prisma.licenseSerial.groupBy({
      by: ['productId'],
      where: { installationId: { not: null }, revokedAt: null },
      _count: { _all: true },
    });
    const revoked = await prisma.licenseSerial.groupBy({
      by: ['productId'],
      where: { revokedAt: { not: null } },
      _count: { _all: true },
    });
    const pick = (list, id) => list.find(c => c.productId === id)?._count._all || 0;
    return products.map(p => ({
      id: p.id, product_id: p.code, name: p.name, active: p.active, created_at: p.createdAt,
      serials: pick(counts, p.id), activated: pick(active, p.id), revoked: pick(revoked, p.id),
    }));
  }

  async function createProduct({ product_id, name }) {
    if (!isValidProductId(product_id)) throw badRequest('product_id inválido: minúsculas, números y guiones (2-64)');
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw badRequest('name requerido (máx. 120)');
    const exists = await prisma.licenseProduct.findUnique({ where: { code: product_id } });
    if (exists) throw new LicenseError(409, 'product_exists', 'Ya existe un producto con ese product_id');
    const p = await prisma.licenseProduct.create({ data: { code: product_id, name: name.trim() } });
    return { id: p.id, product_id: p.code, name: p.name, active: p.active, created_at: p.createdAt };
  }

  async function updateProduct(id, { name, active }) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) throw badRequest('id inválido');
    const data = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 120) throw badRequest('name inválido');
      data.name = name.trim();
    }
    if (active !== undefined) {
      if (typeof active !== 'boolean') throw badRequest('active debe ser booleano');
      data.active = active;
    }
    const exists = await prisma.licenseProduct.findUnique({ where: { id: n } });
    if (!exists) throw new LicenseError(404, 'not_found', 'Producto no encontrado');
    const p = await prisma.licenseProduct.update({ where: { id: n }, data });
    return { id: p.id, product_id: p.code, name: p.name, active: p.active, created_at: p.createdAt };
  }

  // Devuelve los seriales en claro UNA sola vez
  async function createSerials({ product_id, count = 1, note }) {
    if (!isValidProductId(product_id)) throw badRequest('product_id inválido');
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw badRequest('count debe ser un entero entre 1 y 100');
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 255)) throw badRequest('note inválida (máx. 255)');
    const product = await prisma.licenseProduct.findUnique({ where: { code: product_id } });
    if (!product) throw new LicenseError(404, 'not_found', 'Producto no encontrado');

    const created = [];
    for (let i = 0; i < n; i++) {
      const serial = generateSerial();
      const normalized = normalizeSerial(serial);
      const row = await prisma.licenseSerial.create({
        data: { productId: product.id, serialHash: hashSerial(normalized), masked: maskSerial(normalized), note: note?.trim() || null },
      });
      created.push({ id: row.id, serial, masked: row.masked });
    }
    return { product_id, serials: created };
  }

  async function listSerials({ product_id, status, q, page = 1, page_size = 50 } = {}) {
    const where = {};
    if (product_id) {
      if (!isValidProductId(product_id)) throw badRequest('product_id inválido');
      where.product = { code: product_id };
    }
    if (status === 'revoked') where.revokedAt = { not: null };
    else if (status === 'active') { where.revokedAt = null; where.installationId = { not: null }; }
    else if (status === 'unused') { where.revokedAt = null; where.installationId = null; }
    else if (status) throw badRequest('status debe ser active, unused o revoked');
    const term = typeof q === 'string' ? q.trim().slice(0, 128) : '';
    if (term) {
      const or = [{ note: { contains: term } }, { installationId: { contains: term } }, { masked: { endsWith: term.toUpperCase() } }];
      if (/^\d+$/.test(term)) or.push({ id: Number(term) });
      where.OR = or;
    }
    const size = Math.min(200, Math.max(1, Number(page_size) || 50));
    const p = Math.max(1, Number(page) || 1);
    const [total, rows] = await Promise.all([
      prisma.licenseSerial.count({ where }),
      prisma.licenseSerial.findMany({ where, include: { product: true }, orderBy: { id: 'desc' }, skip: (p - 1) * size, take: size }),
    ]);
    return { total, page: p, page_size: size, serials: rows.map(toAdmin) };
  }

  async function getSerial(id) {
    return toAdmin(await getSerialRow(id));
  }

  // Consultar un serial en claro (p. ej. el que manda un cliente a soporte)
  async function lookupSerial({ serial, product_id }) {
    const normalized = normalizeSerial(serial);
    if (!normalized) throw new LicenseError(404, 'not_found', 'Serial no encontrado');
    const row = await prisma.licenseSerial.findUnique({ where: { serialHash: hashSerial(normalized) }, include: { product: true } });
    if (!row || (product_id && row.product.code !== product_id)) throw new LicenseError(404, 'not_found', 'Serial no encontrado');
    return toAdmin(row);
  }

  async function revokeSerial(id, { reason } = {}) {
    if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 255)) throw badRequest('reason inválida (máx. 255)');
    const row = await getSerialRow(id);
    if (row.revokedAt) return toAdmin(row);
    const updated = await prisma.licenseSerial.update({
      where: { id: row.id }, data: { revokedAt: now(), revokeReason: reason?.trim() || null }, include: { product: true },
    });
    return toAdmin(updated);
  }

  async function unrevokeSerial(id) {
    const row = await getSerialRow(id);
    const updated = await prisma.licenseSerial.update({
      where: { id: row.id }, data: { revokedAt: null, revokeReason: null }, include: { product: true },
    });
    return toAdmin(updated);
  }

  async function resetActivation(id) {
    const row = await getSerialRow(id);
    if (!row.installationId) return toAdmin(row);
    const updated = await prisma.licenseSerial.update({
      where: { id: row.id },
      data: { installationId: null, activatedAt: null, resetCount: { increment: 1 } },
      include: { product: true },
    });
    return toAdmin(updated);
  }

  function publicKeyInfo() {
    const keys = getKeys();
    if (!keys) return { configured: false };
    return { configured: true, kid: keys.kid, algorithm: 'EdDSA (Ed25519)', public_key_pem: keys.publicKeyPem, public_key_raw_base64: keys.publicKeyRawBase64, license_days: LICENSE_DAYS };
  }

  return {
    activate, validate,
    listProducts, createProduct, updateProduct,
    createSerials, listSerials, getSerial, lookupSerial, revokeSerial, unrevokeSerial, resetActivation,
    publicKeyInfo,
  };
}

let defaultService = null;
export function getLicenseService() {
  if (!defaultService) defaultService = createLicenseService({ prisma: new PrismaClient() });
  return defaultService;
}
