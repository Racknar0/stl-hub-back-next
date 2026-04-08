# STL HUB Backend

Backend API para una plataforma de distribucion de modelos STL con gestion de assets, suscripciones, almacenamiento en MEGA y busqueda semantica con embeddings.

## Resumen

Este servicio expone una API REST en Node.js para:

- autenticacion y autorizacion de usuarios
- gestion de assets STL (metadata, tags, categorias, descargas)
- integracion de pagos y planes premium
- upload y replicacion de archivos en cuentas MEGA
- busqueda semantica con Gemini Embeddings + Qdrant
- operaciones batch para ingesta masiva y sincronizacion

## Stack Tecnologico

- Runtime: Node.js (ES Modules)
- Framework: Express
- ORM: Prisma
- Base de datos: MySQL
- Vector DB: Qdrant
- Embeddings: Google GenAI (`@google/genai`)
- Auth: JWT + bcrypt
- Uploads: multer + sharp
- Correo: nodemailer

## Arquitectura

- `server.js`: bootstrap del servidor HTTP
- `app.js`: composicion de middlewares y rutas
- `src/controllers`: logica de endpoints
- `src/routes`: definicion de rutas API
- `src/workers`: procesos batch y orquestacion de cargas
- `src/services`: integraciones externas y servicios reutilizables
- `prisma/schema.prisma`: modelo de datos
- `uploads/`: archivos temporales, imagenes y archivos finales

## Funcionalidades Destacadas

### 1) Catalogo STL y Metadata

- CRUD de assets
- categorias y tags multiidioma
- historico de descargas
- status de publicacion

### 2) Busqueda Semantica IA

- generacion de embeddings por asset
- indexacion en Qdrant
- endpoint de busqueda IA con ranking semantico
- endpoint de sincronizacion de vectores faltantes con logs SSE
- reintentos robustos ante microcortes de red

### 3) Upload Batch de Produccion

- flujo de ingesta por lotes
- subida principal + backups en cuentas MEGA
- creacion de asset y vectorizacion automatica al crear
- reintentos y recuperacion ante fallos transitorios

### 4) Suscripciones y Premium

- integracion con proveedores de pago
- control de acceso por tipo de plan
- validaciones de estado de suscripcion

## Variables de Entorno Clave

Configurar un archivo `backend/.env` con al menos:

- `PORT`
- `DATABASE_URL`
- `JWT_SECRET`
- `CORS_ORIGINS`
- `FRONT_URL`
- `GEMINI_API_KEY` (o `GOOGLE_API_KEY`)
- `QDRANT_HOST`
- `QDRANT_PORT`
- `QDRANT_COLLECTION`
- `GEMINI_EMBEDDING_MODEL`

Tambien hay variables opcionales para SMTP, PayPal, MEGA y tareas operativas.

## Scripts

Desde la carpeta `backend/`:

```bash
npm install
npm run dev
```

Scripts disponibles (segun `package.json`):

- `npm run dev`: desarrollo con nodemon
- `npm run start`: arranque de produccion
- `npm run seed`: seed inicial
- `npm run randomize:freebies`: utilidad operativa

## Flujo de Desarrollo

1. Instalar dependencias
2. Configurar `.env`
3. Ejecutar backend en modo dev
4. Verificar conexion DB y Qdrant
5. Probar endpoints desde frontend o cliente API

## Endpoints Relevantes

- `GET /api/assets/search`
- `GET /api/ai/sync-status`
- `POST /api/ai/sync-missing`
- `POST /api/auth/*`
- `POST /api/payments/*`

## Buenas Practicas Aplicadas

- separacion por capas (routes/controllers/services/workers)
- configuracion por entorno (sin hardcodes)
- logs de diagnostico para cargas y vectorizacion
- tratamiento de errores transitorios con reintentos
- sincronizacion incremental de vectores para consistencia

## Enfoque Portafolio

Este backend demuestra capacidad para construir sistemas reales orientados a producto:

- arquitectura modular y mantenible
- integracion de IA aplicada al negocio
- procesamiento batch con resiliencia
- seguridad, observabilidad y escalabilidad progresiva
