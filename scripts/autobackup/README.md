# STL Hub — Sistema de Backup Automatizado

## Descripción

Script Node.js que ejecuta un backup FULL diario de todos los componentes críticos de STL Hub y los sube a Google Drive vía `rclone`.

### ¿Qué respalda?

| Componente | Archivo generado | Descripción |
|---|---|---|
| MySQL | `mysql_stl_hub_20260513_0400.sql.gz` | Dump completo de la base de datos, comprimido |
| Qdrant | `qdrant_stls-multimodal_20260513.snapshot` | Snapshot de la colección de vectores IA |
| .env | `env_20260513` | Copia del archivo de configuración con credenciales |
| Imágenes | `images_20260513.tar.gz` | Todas las imágenes de preview de assets |

### Retención

| Ubicación | Copias | Descripción |
|---|---|---|
| **Local** (VPS) | 1 | Solo el último backup (ahorra disco) |
| **Google Drive** | 2 | El actual + el anterior (protección contra corrupción) |

---

## Setup Inicial (una sola vez en el VPS)

### 1. Instalar rclone

```bash
curl https://rclone.org/install.sh | sudo bash
```

### 2. Configurar Google Drive

```bash
rclone config
```

Seguir los pasos:
1. `n` → New remote
2. Nombre: `gdrive`
3. Storage: `Google Drive` (opción 18 o buscar "drive")
4. Client ID y Secret: dejar vacío (usa los defaults)
5. Scope: `1` (Full access)
6. Root folder: dejar vacío
7. Service Account: dejar vacío
8. Auto config: `n` (estás en un servidor headless)
9. Te dará un **comando para ejecutar en tu máquina local** que tiene browser
10. Pegar el token resultante
11. Team Drive: `n`
12. Confirmar: `y`

Verificar:
```bash
rclone lsf gdrive:
```

### 3. Crear directorio de backups

```bash
mkdir -p /var/www/backend/.backups
chmod 700 /var/www/backend/.backups
```

### 4. Agregar variables al .env

```env
# ==============================
# Backup
# ==============================
BACKUP_DIR=/var/www/backend/.backups
BACKUP_RCLONE_REMOTE=gdrive
BACKUP_RCLONE_PATH=stlhub-backups
BACKUP_DRIVE_RETENTION=2
```

### 5. Configurar el cron

```bash
crontab -e
```

Agregar esta línea:

```
0 9 * * * cd /var/www/backend && node --env-file=.env scripts/autobackup/backup.js >> /var/log/stlhub-backup.log 2>&1
```

> Esto ejecuta el backup a las **4:00 AM hora Colombia** (09:00 UTC) todos los días.

### 6. Ejecutar manualmente para probar

```bash
cd /var/www/backend
node --env-file=.env scripts/autobackup/backup.js
```

---

## Cómo Restaurar un Backup

### Opción A: Restaurar desde Google Drive

#### 1. Descargar el backup

Desde Google Drive, descarga la carpeta completa del día que necesites. O desde el VPS:

```bash
rclone copy gdrive:stlhub-backups/2026-05-13/ /tmp/restore/
```

#### 2. Restaurar MySQL

```bash
# Descomprimir
gunzip mysql_stl_hub_20260513_0400.sql.gz

# Restaurar (te pedirá password)
mysql -u root -p stl_hub < mysql_stl_hub_20260513_0400.sql
```

Si la base de datos no existe:
```bash
mysql -u root -p -e "CREATE DATABASE stl_hub;"
mysql -u root -p stl_hub < mysql_stl_hub_20260513_0400.sql
```

#### 3. Restaurar Qdrant

Usando la API REST de Qdrant:

```bash
# Si la colección no existe, el restore la crea automáticamente
curl -X POST "http://localhost:6333/collections/stls-multimodal/snapshots/upload" \
  -H "Content-Type: multipart/form-data" \
  -F "snapshot=@qdrant_stls-multimodal_20260513.snapshot"
```

Si la colección ya existe y quieres sobrescribirla:
```bash
# Borrar colección existente
curl -X DELETE "http://localhost:6333/collections/stls-multimodal"

# Restaurar desde snapshot
curl -X POST "http://localhost:6333/collections/stls-multimodal/snapshots/upload" \
  -H "Content-Type: multipart/form-data" \
  -F "snapshot=@qdrant_stls-multimodal_20260513.snapshot"
```

#### 4. Restaurar .env

```bash
cp env_20260513 /var/www/backend/.env
```

#### 5. Restaurar Imágenes

```bash
# Desde la carpeta del backend
tar xzf images_20260513.tar.gz -C /var/www/backend/uploads/
```

---

### Opción B: Restaurar en Windows (entorno local)

#### MySQL
```powershell
# Descomprimir (necesitas 7-Zip o gzip para Windows)
# Luego:
mysql -u root -p stl_hub < mysql_stl_hub_20260513_0400.sql
```

#### Qdrant
```powershell
# Usando curl o Invoke-WebRequest
curl -X POST "http://localhost:6333/collections/stls-multimodal/snapshots/upload" `
  -H "Content-Type: multipart/form-data" `
  -F "snapshot=@qdrant_stls-multimodal_20260513.snapshot"
```

#### .env
```powershell
Copy-Item env_20260513 .env
```

#### Imágenes
```powershell
# Usar 7-Zip o tar (disponible en Windows 10+)
tar xzf images_20260513.tar.gz -C uploads/
```

---

## Estructura de Archivos

```
backend/
├── scripts/
│   └── autobackup/
│       ├── backup.js      ← Script principal
│       └── README.md      ← Este archivo
├── .backups/              ← Solo en el VPS, chmod 700
│   └── 2026-05-13/
│       ├── mysql_stl_hub_20260513_0400.sql.gz
│       ├── qdrant_stls-multimodal_20260513.snapshot
│       ├── env_20260513
│       └── images_20260513.tar.gz
└── .env                   ← Contiene config de backup
```

Google Drive:
```
stlhub-backups/
├── 2026-05-13/            ← Último backup
│   ├── mysql_stl_hub_20260513_0400.sql.gz
│   ├── qdrant_stls-multimodal_20260513.snapshot
│   ├── env_20260513
│   └── images_20260513.tar.gz
└── 2026-05-12/            ← Backup anterior
    └── ...
```

---

## Notificaciones

El script crea una notificación automática en el dashboard de admin después de cada ejecución:

- **✅ Backup FULL completado** — todo OK, con tamaños y tiempo
- **❌ Backup FULL falló** — detalle de qué paso(s) fallaron

Las notificaciones aparecen en el panel de notificaciones del dashboard con tipo `AUTOMATION`.

---

## Troubleshooting

### El backup no se ejecuta

1. Verificar que el cron está activo: `crontab -l`
2. Revisar logs: `tail -f /var/log/stlhub-backup.log`
3. Ejecutar manualmente: `cd /var/www/backend && node --env-file=.env scripts/autobackup/backup.js`

### rclone falla con error de autenticación

```bash
# Re-autorizar
rclone config reconnect gdrive:
```

### mysqldump falla

```bash
# Verificar que está instalado
which mysqldump

# Si no está:
apt install mysql-client
```

### El backup de imágenes es muy lento

Es normal si el directorio de imágenes es grande (>1 GB). El timeout es de 1 hora.
Si necesitas más, editar `timeout` en la función `backupImages()` del script.

### Espacio en disco del VPS

El script solo mantiene 1 backup local. Si el VPS tiene poco espacio, revisar:
```bash
df -h
du -sh /var/www/backend/.backups/*
```
