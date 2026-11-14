# Email marketing — backend

Módulo del dashboard: embudos, audiencias y limpieza de contactos.
No confundir con `/api/admin/marketing`, que son las campañas UTM de adquisición.

## Qué falta para ponerlo en marcha

1. **Migración** (toca la base de datos, hacerla a conciencia):

   ```bash
   cd backend
   npx prisma migrate dev --name email_marketing
   ```

   Crea `emailcontact`, `emaillog` y `emailevent`. No modifica ninguna tabla
   existente: en `user` solo añade una relación inversa, que no cambia columnas.

2. **Regenerar el cliente** si la migración no lo hace sola (requiere el backend parado,
   en Windows el `.dll` queda bloqueado):

   ```bash
   npx prisma generate
   ```

3. **Variables de entorno** nuevas en `.env`:

   ```
   # Secreto del webhook de Brevo (obligatorio para que el webhook responda)
   BREVO_WEBHOOK_SECRET=<cadena larga al azar>

   # Opcionales: ventanas de clasificación (valores por defecto entre paréntesis)
   EMAIL_ACTIVE_DAYS=60           # (60) sin señales => dormido
   EMAIL_NEW_DAYS=15              # (15) recién registrado
   EMAIL_DORMANT_MIN_AGE_DAYS=45  # (45) margen antes de marcar dormido
   EMAIL_REENGAGE_GRACE_DAYS=10   # (10) días para reaccionar al reenganche
   EMAIL_DAILY_LIMIT=300          # (300) tope diario del plan de Brevo
   ```

   `BREVO_API_KEY` ya existía y se reutiliza.

4. **Webhook en Brevo** → Transaccional → Email → Webhook:

   ```
   https://<dominio>/api/webhooks/brevo?secret=<BREVO_WEBHOOK_SECRET>
   ```

   Eventos a marcar: delivered, opened, click, hard_bounce, soft_bounce,
   spam, unsubscribed, blocked.

5. **Cron diario** para mantener las etapas al día:

   ```
   0 6 * * * cd /ruta/backend && node --env-file=.env scripts/syncEmailStages.js
   ```

## Endpoints

Todos bajo `/api/admin/email-marketing`, con `requireAuth` + `requireAdmin`.

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/overview` | Métricas de la pantalla Resumen |
| GET | `/flows` | Embudo de bienvenida con contadores por paso |
| GET | `/audiences` | Conteo por etapa + premium |
| GET | `/audiences/:stage` | Listado paginado (`NEW`, `ACTIVE`, `DORMANT`, `OPTED_OUT`, `ALL`) |
| GET | `/templates` | Plantillas leídas de Brevo |
| GET | `/logs` | Últimos envíos registrados |
| POST | `/sync` | Recalcula las etapas a mano |
| POST | `/contacts/:userId/opt-out` | Saca del marketing (`{ reason }`) |
| POST | `/contacts/:userId/opt-in` | Lo devuelve al marketing |

Webhook público: `POST /api/webhooks/brevo?secret=…`

## Cómo se decide la etapa

`emailMarketing.service.js` → `computeStage()`. En orden:

1. `optedOutAt` → **OPTED_OUT** (solo se sale a mano o con un opt-in).
2. Alguna señal en los últimos `ACTIVE_DAYS` → **ACTIVE**.
3. Registrado hace menos de `NEW_DAYS` → **NEW**.
4. Registrado hace más de `DORMANT_MIN_AGE_DAYS` sin señales → **DORMANT**.
5. En medio → **NEW** (acaba de terminar el embudo, se le da margen).

Cuentan como señal: `user.lastLogin`, la última fila de `downloadhistory`,
y `lastOpenAt` / `lastClickAt` que llegan por webhook.

Las aperturas **no son fiables** por sí solas (fallan si el lector bloquea
imágenes y se disparan solas en Apple Mail), así que nunca se usan como
único criterio: alguien que entra a la web y descarga no es un dormido
aunque no abra un solo correo.

## Lo que todavía no hace

- **No envía nada.** `brevo.service.js` tiene `sendTemplate()` listo, pero
  ningún proceso lo llama: el embudo sigue corriendo dentro de Brevo.
- **`EmailLog` se llena solo con lo que enviemos desde aquí.** Lo que salga
  del panel de Brevo no aparece hasta que llegue su webhook, y aun así sin
  fila previa no se puede enlazar a un envío concreto.
- **Sin gestión de bajas propia.** Si algún día enviamos desde el servidor,
  hace falta un enlace de baja y su endpoint público. Es obligatorio.
