# Servidor de licencias (programas de escritorio)

Licencias para programas propios (PondWatch Update y los que vengan). Cada programa es un **producto** con su
`product_id`; cada **serial** pertenece a un producto y se activa en **una** instalación.

- Código: `src/services/licenses.service.js`, `src/utils/licenseCrypto.js`, `src/controllers/licenses.controller.js`,
  `src/routes/licenses/index.js`. Tablas `license_product` y `license_serial` (migración `20261119003212_license_server`).
- Dashboard: **Configuración → Keys softwares**.
- Pruebas: `node --env-file=.env --test test/licenses.test.js test/licenses.db.test.js` (la segunda usa la base local
  y lanza 20 activaciones simultáneas del mismo serial).

## Reglas

| Tema | Comportamiento |
|---|---|
| Serial | 25 caracteres Crockford Base32 aleatorios (125 bits), `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Se aceptan minúsculas, espacios y sin guiones; O→0, I/L→1. |
| Almacenamiento | Solo SHA-256 del serial normalizado y una versión enmascarada (`*****-*****-*****-*****-*K7MQ`). El serial en claro se devuelve **una sola vez** al crearlo. |
| Activación | Un serial = una instalación. Misma instalación → idempotente (200 con token nuevo). Otra → `409 already_activated`. |
| Atomicidad | `UPDATE … WHERE id = ? AND installationId IS NULL AND revokedAt IS NULL`; solo gana quien actualiza la fila. |
| Licencia | JWT `EdDSA` (Ed25519), válido **30 días**. La primera activación requiere internet. |
| Validación | Al abrir el programa: comprueba el estado en el servidor y devuelve un token renovado 30 días. Un token vencido pero bien firmado también se renueva si el serial sigue activo en esa instalación. |
| Sin conexión | El programa usa el token guardado hasta su `exp`. |
| Revocación | Efecto en la siguiente validación con conexión o, como máximo, al vencer el token (30 días). |
| Errores | Serial inexistente, de otro producto o producto inexistente → mismo `404 invalid_serial`. |
| Límites por IP | `/activate`: 10/min y 50/h; tras 20 seriales inválidos en una hora, bloqueo hasta que pase la hora. `/validate`: 30/min. En memoria del proceso. |

**Aviso:** `installation_id` lo genera el programa y se puede copiar junto con sus archivos. Limita el uso casual
de un serial en varias PCs, pero **no es una protección absoluta contra la clonación**.

## Configuración (`/var/www/backend/.env`)

```env
# Clave privada Ed25519 (PKCS#8 DER en Base64) con la que se firman las licencias. Secreta.
LICENSE_SIGNING_PRIVATE_KEY=<salida del script>
# Identificador de la clave de firma (campo "kid" de la licencia)
LICENSE_SIGNING_KEY_ID=k1
```

Generar las claves: `node scripts/generate-license-keys.js`. Imprime la línea de la clave privada (va al `.env`)
y la clave pública en PEM y en Base64 de 32 bytes (va a los programas). La clave pública también se ve en el
dashboard y en `GET /api/admin/licenses/public-key`. Sin la clave privada, los endpoints públicos responden
`503 licensing_unavailable`.

Rotar la clave invalida todas las licencias emitidas (los programas necesitan la nueva clave pública y volver a
activar), así que solo se rota si la privada se filtra.

## API pública (programas)

Base: `https://stlgratis.com/api/v1/licenses` · JSON · sin autenticación.

### `POST /activate`

```json
{ "product_id": "pondwatch-update", "serial": "7K3QF-M9X2T-PZ4VB-H8NWC-1RD6J", "installation_id": "3f1c9a52-6b0e-4d7f-9a21-8c4e2b7d5f10" }
```

`200`:

```json
{
  "valid": true,
  "license": "<JWT>",
  "expires_at": "2026-12-19T00:00:00.000Z",
  "product_id": "pondwatch-update",
  "installation_id": "3f1c9a52-6b0e-4d7f-9a21-8c4e2b7d5f10",
  "activated_at": "2026-11-19T00:00:00.000Z"
}
```

### `POST /validate`

```json
{ "product_id": "pondwatch-update", "installation_id": "3f1c9a52-6b0e-4d7f-9a21-8c4e2b7d5f10", "license": "<JWT>" }
```

`200` vigente: `{ "valid": true, "license": "<JWT nuevo>", "expires_at": "…" }`

`200` no vigente: `{ "valid": false, "reason": "<motivo>", "message": "<texto>" }`

| reason | Significado |
|---|---|
| `revoked` | Serial revocado |
| `activation_released` | El admin liberó la activación |
| `installation_mismatch` | El token es de otra instalación, o el serial está activado en otra |
| `product_mismatch` | El token es de otro producto |
| `product_disabled` | Producto desactivado |
| `invalid_license` | Firma o formato inválido, o serial inexistente |

### Errores HTTP

`{ "error": "<código>", "message": "<texto>" }`

| HTTP | error | Cuándo |
|---|---|---|
| 400 | `invalid_request` | Faltan campos o tienen formato inválido (`product_id`: `^[a-z0-9][a-z0-9-]{1,63}$`; `installation_id`: `^[A-Za-z0-9._:-]{8,128}$`) |
| 404 | `invalid_serial` | Serial inexistente, de otro producto o producto inexistente/desactivado |
| 409 | `already_activated` | Serial activado en otra instalación |
| 403 | `revoked` | Serial revocado (solo `/activate`) |
| 429 | `rate_limited` | Demasiados intentos; cabecera `Retry-After` (segundos) |
| 503 | `licensing_unavailable` | Falta la clave de firma en el servidor |
| 500 | `internal_error` | Error interno |

### Token

Header `{"alg":"EdDSA","typ":"JWT","kid":"k1"}`. Payload:

```json
{ "iss": "stlhub-licenses", "sub": "<id del serial>", "pid": "pondwatch-update", "iid": "<installation_id>", "iat": 1795046400, "exp": 1797638400 }
```

Verificación sin conexión: firma Ed25519 sobre `base64url(header).base64url(payload)` con la clave pública;
`iss == "stlhub-licenses"`, `pid` = producto, `iid` = `installation_id` local y `exp` (segundos Unix) mayor que ahora.

## API administrativa

Base `https://stlgratis.com/api/admin/licenses`. Autenticación: la misma sesión del dashboard,
`Authorization: Bearer <JWT de login>` de un usuario admin (`requireAuth` + `requireAdmin`, `roleId = 2`).
Sin token → `401`; usuario no admin → `403`.

| Método y ruta | Cuerpo / query | Respuesta |
|---|---|---|
| `GET /public-key` | — | `{ configured, kid, algorithm, public_key_pem, public_key_raw_base64, license_days }` |
| `GET /products` | — | `[{ id, product_id, name, active, serials, activated, revoked, created_at }]` |
| `POST /products` | `{ "product_id": "pondwatch-update", "name": "PondWatch Update" }` | producto creado (`409 product_exists` si ya existe) |
| `PATCH /products/:id` | `{ "name"?: "…", "active"?: false }` | producto |
| `POST /serials` | `{ "product_id": "pondwatch-update", "count": 5, "note": "Pedido 123" }` (count 1–100) | `{ product_id, serials: [{ id, serial, masked }] }` — **única vez** que se ve el serial |
| `GET /serials` | `?product_id=&status=active\|unused\|revoked&q=&page=1&page_size=50` (`q`: ID, últimos 4, nota o instalación) | `{ total, page, page_size, serials: [Serial] }` |
| `GET /serials/:id` | — | `Serial` |
| `POST /serials/lookup` | `{ "serial": "7K3QF-…", "product_id"?: "…" }` | `Serial` (`404 not_found`) |
| `POST /serials/:id/revoke` | `{ "reason"?: "Reembolso" }` | `Serial` |
| `POST /serials/:id/unrevoke` | — | `Serial` |
| `POST /serials/:id/reset-activation` | — | `Serial` (libera la instalación; `reset_count` + 1) |

`Serial` = `{ id, product_id, product_name, masked, status: "active"|"unused"|"revoked", note, installation_id,
activated_at, last_validated_at, reset_count, revoked_at, revoke_reason, created_at }`.

Ejemplo:

```bash
curl -X POST https://stlgratis.com/api/admin/licenses/serials \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"product_id":"pondwatch-update","count":1,"note":"cliente prueba"}'
```

## Verificar en producción

1. `GET https://stlgratis.com/api/admin/licenses/public-key` con token admin → `configured: true`.
2. Dashboard → Configuración → Keys softwares: crear el producto y un serial de prueba.
3. `curl -X POST https://stlgratis.com/api/v1/licenses/activate -H "Content-Type: application/json" -d '{"product_id":"pondwatch-update","serial":"<serial>","installation_id":"test-install-0001"}'` → `200 valid:true`.
4. Repetirlo → `200` (idempotente). Con otro `installation_id` → `409 already_activated`.
5. `POST /validate` con el token → `200 valid:true` con token nuevo. Revocar en el dashboard y repetir → `valid:false, reason:"revoked"`.
