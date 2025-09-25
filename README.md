# STL HUB — Backend

Backend robusto y escalable para la plataforma STL HUB, desarrollado en **Node.js** con **Express** y **Prisma ORM**. Gestiona la lógica de negocio, autenticación, pagos, notificaciones, administración de assets digitales y la integración avanzada con MEGA.nz.

---

## 🚀 Características principales

- **API RESTful** moderna y segura
- **Autenticación JWT** y activación de cuentas por email
- **Recuperación y reseteo de contraseña**
- **Gestión de assets**: subida, edición, categorías, tags, control de descargas y links MEGA
- **Sistema de notificaciones** y reportes de links caídos
- **Integración con MEGA.nz** para almacenamiento y chequeo de links
- **Pagos y suscripciones** (PayPal, Stripe, etc.)
- **Panel de administración** (vía frontend)
- **Internacionalización de mensajes (es/en)**
- **Logs avanzados y backups automáticos**
- **Migraciones de base de datos con Prisma**

---

## 📁 Estructura del proyecto

```
backend/
│
├── .env                  # Variables de entorno (claves, URLs, etc.)
├── app.js                # Entry point principal
├── package.json          # Dependencias y scripts
├── prisma/               # Esquema y migraciones de base de datos
│   ├── schema.prisma
│   └── migrations/
├── seed/                 # Scripts de seed para datos iniciales
├── src/
│   ├── db.js             # Instancia central de PrismaClient
│   ├── controllers/      # Lógica de negocio (assets, users, pagos, etc.)
│   ├── middlewares/      # Middlewares de autenticación, validación, etc.
│   ├── routes/           # Definición de rutas y endpoints
│   ├── utils/            # Utilidades (MEGA, logs, crypto, backups, etc.)
├── uploads/              # Archivos subidos (archivos, imágenes, temporales)
└── README.md             # Este archivo
```

---

## ⚙️ Instalación y ejecución

1. **Clona el repositorio:**
   ```bash
   git clone https://github.com/tuusuario/stlhub-backend.git
   cd stlhub-backend
   ```

2. **Instala las dependencias:**
   ```bash
   npm install
   # o
   yarn install
   ```

3. **Configura las variables de entorno:**
   - Renombra `.env.example` a `.env` y completa los valores necesarios (DB, JWT, SMTP, MEGA, PayPal, etc.)

4. **Ejecuta las migraciones de base de datos:**
   ```bash
   npx prisma migrate deploy
   # o para desarrollo
   npx prisma migrate dev
   ```

5. **(Opcional) Ejecuta el seed inicial:**
   ```bash
   node seed/seed.js
   ```

6. **Inicia el servidor:**
   ```bash
   npm run dev
   # o
   yarn dev
   ```

7. **La API estará disponible en:**
   [http://localhost:3001/api](http://localhost:3001/api)

---

## 🧩 Principales módulos y rutas

- `/api/auth` — Registro, login, activación, recuperación de contraseña
- `/api/assets` — Gestión de assets y descargas
- `/api/categories` — Categorías de assets
- `/api/tags` — Tags de assets
- `/api/users` — Gestión de usuarios
- `/api/notifications` — Notificaciones y reportes
- `/api/payments` — Pagos y suscripciones
- `/api/reports` — Reporte de links caídos

---

## 🛠️ Tecnologías y librerías clave

- **Node.js** — Entorno de ejecución
- **Express** — Framework web
- **Prisma ORM** — Acceso y migración de base de datos
- **MySQL** — Motor de base de datos (puedes adaptar a PostgreSQL)
- **MEGAcmd** — Integración con MEGA.nz para descargas y chequeos
- **nodemailer** — Envío de emails (activación, recuperación, notificaciones)
- **jsonwebtoken** — Autenticación JWT
- **bcrypt** — Hash de contraseñas
- **dotenv** — Variables de entorno
- **winston** — Logging avanzado

---

## 🔒 Seguridad y buenas prácticas

- **Nunca subas tu archivo `.env` ni claves privadas al repositorio.**
- Usa HTTPS en producción.
- Valida y sanitiza todos los datos de entrada.
- Protege rutas sensibles con middlewares de autenticación y roles.
- Limita la concurrencia de chequeos MEGA para evitar bloqueos.
- Haz backups periódicos de la base de datos y archivos.

---

## 💡 Consejos de desarrollo

- Centraliza la instancia de PrismaClient en `src/db.js` y reutilízala.
- Usa los helpers de `src/utils/` para lógica común (crypto, logs, MEGA, etc.)
- Mantén los controladores limpios y delega lógica repetitiva a utilidades.
- Documenta tus endpoints y flujos críticos.
- Usa migraciones para cualquier cambio en el modelo de datos.

---

## 📦 Despliegue

- Puedes desplegar en cualquier VPS, servidor dedicado o plataforma cloud compatible con Node.js y tu base de datos.
- Asegúrate de configurar correctamente las variables de entorno y los servicios externos (MEGA, SMTP, PayPal, etc.)

---

## 📚 Recursos útiles

- [Documentación Express](https://expressjs.com/)
- [Prisma ORM](https://www.prisma.io/docs)
- [MEGAcmd](https://mega.nz/cmd)
- [Nodemailer](https://nodemailer.com/about/)
- [JWT](https://jwt.io/)

---

**STL HUB Backend** — Potencia, seguridad y flexibilidad para tu plataforma de assets digitales.
