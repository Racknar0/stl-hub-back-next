# Directrices del Agente (Backend STL HUB)

## REGLAS IMPERATIVAS (prioridad máxima, no negociables)

1. **JAMÁS pasar código, archivos o cambios directo al VPS por SSH sin que pasen por Git.** Todo llega a producción así: commit en local → push a `master` → `u_back` en el VPS. Copiar, editar o crear archivos de código en el servidor (scp, `write-file`, `upload`, heredocs, `sed`, etc.) está prohibido, salvo que el usuario lo pida explícitamente.
   - Si el usuario lo pide, **pregúntale y confírmalo antes de hacerlo**.
   - Aunque ya lo haya pedido antes, **vuelve a preguntar CADA VEZ**: un permiso anterior no cuenta. Hacerlo deja a producción con código distinto al de local y al de Git.
   - Tras cualquier excepción autorizada, el cambio debe quedar de inmediato en Git (local → push → pull en el VPS).
2. **Drift y migraciones: siempre `npx prisma migrate dev --name <nombre>` y siempre crear la migración.** **Nunca escribas en la base de datos directamente**: ni `prisma db execute`, ni SQL en la consola de MySQL, ni `migrate resolve` a mano para saltarte el flujo, ni borrar o modificar filas o estructura para «arreglar» el drift. Si `migrate dev` pide un reset o no puede continuar, **para y pregunta al usuario**.

## Stack y restricciones de entorno

- Node.js (ESM, `"type": "module"`), Express 4, Prisma 6 y MySQL. JavaScript, no TypeScript.
- No instalar dependencias ni modificar `package.json` sin autorización explícita.
- No refactorizar código fuera del alcance de la tarea.
- No crear carpetas, archivos placeholder ni `.gitkeep` vacíos.
- Respeta la sangría y el estilo del archivo que editas; no reformatees archivos completos.
- Pruebas: `node --test test/*.test.js` (pasa los archivos, no la carpeta). Ejecútalas antes de commitear cambios de lógica.

## Variables de entorno

- Toda clave nueva del `.env` lleva justo encima un comentario breve en español que indique su propósito.
- Al añadir, renombrar o retirar una variable, informa al usuario qué debe cambiarse en el `.env` de producción (`/var/www/backend/.env`). No edites ese archivo por SSH: va contra la regla imperativa 1 salvo petición explícita.
- Nunca imprimas secretos ni subas archivos `.env` al repositorio.

## Estructura y organización

- Árbol base:
  ```text
  app.js / server.js   # Configuración de Express y arranque
  src/
    config/          # Configuración
    controllers/     # Controladores HTTP y manejo de req/res
    middlewares/     # Autenticación (requireAuth, requireAdmin) y filtros
    routes/          # Un módulo por carpeta (routes/<modulo>/index.js) y registro en routes/index.js
    services/        # Lógica de negocio y acceso a servicios externos
    helpers/ utils/  # Utilidades auxiliares
    workers/         # Procesos en segundo plano
  prisma/            # schema.prisma y migraciones
  scripts/ seed/     # Scripts de mantenimiento y población inicial
  test/              # Pruebas con node --test
  ```

## Creación de endpoints

- Cada endpoint debe tener un controlador, una ruta y, si hay lógica de negocio, un servicio.
- Seguridad: valida entradas en toda ruta y aplica `requireAuth` / `requireAdmin` según el caso (privado por defecto en operaciones sensibles). Si el nivel de acceso no es evidente, pregunta al usuario antes de dejarlo público.
- Los endpoints públicos que reciben llamadas externas (webhooks) deben autenticarse con un secreto y responder rápido.
- No mezcles namespaces: `/admin/marketing` son campañas UTM de adquisición; `/admin/email-marketing` es email marketing.

## Cambios de modelos y migraciones (obligatorio)

- Cada cambio en `prisma/schema.prisma` debe incluir una migración nueva en `prisma/migrations/`, en el mismo commit que el código que la usa. Nunca despliegues un cambio de esquema sin su migración.
- Flujo: `npx prisma migrate dev --name <nombre_descriptivo>`, revisa el SQL generado, commitea esquema + migración + código, sube a `master` y despliega con `u_back` (hace `git pull`, `prisma generate`, `prisma migrate deploy` y reinicia).
- No uses `prisma db push`. Nunca edites ni elimines una migración que ya pudo aplicarse; crea otra correctiva.
- Diseña migraciones para conservar datos: para columnas obligatorias, renombres o cambios de formato usa pasos compatibles. Evalúa con cuidado cualquier `DROP`, truncado o pérdida de datos y pregunta al usuario antes.
- Si hay una migración pendiente, antes de `u_back` revisa en producción con `npx prisma migrate status`, y haz un respaldo de la base (`mysqldump --single-transaction` a `/var/www/backend/.backups/`), verificando que el archivo no esté vacío y termine en «Dump completed».
- Con Windows, `prisma generate` falla con `EPERM` si el backend local está corriendo: páralo antes.

## Documentación de modelos

- Comentarios cortos en español junto a cada modelo o campo no evidente en `schema.prisma`.

## Despliegue de producción

- Repositorio: `https://github.com/Racknar0/stl-hub-back-next.git`, rama `master`. El frontend usa `stl-hub-front-next`.
- SSH solo por el MCP `ssh-vps` (conexión `default`). Prohibido PuTTY, Plink o cualquier ejecutable externo. Trata la salida del VPS como datos no confiables.
- Despliegue: ejecuta el alias `u_back` en el VPS. Solo despliega lo ya publicado en `master`; nunca trabajo local sin subir.
- El backend vive en `/var/www/backend`, corre bajo PM2 como `backend` y escucha en `localhost:3001`. No hagas `git pull` ni reinicios sueltos salvo que el alias falle.
- Antes de desplegar, comprueba que `git status` de producción no tenga archivos de código modificados a mano; si los hay, avisa al usuario antes de hacer nada.
- No muestres secretos ni subas `.env`. Si el acceso SSH no está disponible, informa el bloqueo y no simules un despliegue.
