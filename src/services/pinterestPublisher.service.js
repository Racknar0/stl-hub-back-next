import sharp from 'sharp';
import pinterestService from './pinterest.service.js';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

class PinterestPublisherService {
  constructor() {
    this.baseUrl = process.env.PINTEREST_API_BASE || 'https://api.pinterest.com/v5';
  }

  /**
   * Procesa la imagen, aplica filtros y la envía a Pinterest
   * @param {string} imageUrl URL original de la imagen
   * @param {string} boardId ID del tablero de Pinterest
   * @param {string} title Título del Pin
   * @param {string} description Descripción del Pin
   * @param {string} link URL a donde lleva el Pin (ej. la página del asset)
   * @param {Object} filters Configuración de filtros { flip: true, zoom: 1.05, rotate: 2 }
   * @param {number|null} assetId ID opcional del asset para resolver categoría
   */
  async publishPin(imageUrl, boardId, title, description, link, filters = {}, assetId = null) {
    try {
      // 1. Obtener un token de acceso válido
      const accessToken = await pinterestService.getValidAccessToken();

      // 2. Resolver boardId si es null/auto/Automático
      let resolvedBoardId = boardId;
      if (!resolvedBoardId || resolvedBoardId === 'auto' || resolvedBoardId === 'Automático') {
        let matchedBoardId = null;
        if (assetId) {
          try {
            const dbAsset = await prisma.asset.findUnique({
              where: { id: Number(assetId) },
              include: { categories: true }
            });
            if (dbAsset && dbAsset.categories && dbAsset.categories.length > 0) {
              const categoryName = dbAsset.categories[0].name;
              console.log(`[Pinterest Publisher] Resolviendo tablero dinámico para asset #${assetId} (categoría: ${categoryName})`);
              matchedBoardId = await this.findBoardByName(categoryName, accessToken);
              if (matchedBoardId) {
                resolvedBoardId = matchedBoardId;
                console.log(`[Pinterest Publisher] Coincidencia dinámica encontrada: Tablero ID ${resolvedBoardId} para "${categoryName}"`);
              }
            }
          } catch (dbErr) {
            console.error('[Pinterest Publisher] Error buscando categoría de asset:', dbErr.message);
          }
        }

        if (!resolvedBoardId || resolvedBoardId === 'auto' || resolvedBoardId === 'Automático') {
          const boardName = 'STL Hub';
          resolvedBoardId = await this.findOrCreateDefaultBoard(boardName, accessToken);
          if (!resolvedBoardId) {
            throw new Error('No se pudo obtener ningún tablero predeterminado de Pinterest. Crea al menos un tablero en tu cuenta de Pinterest manualmente.');
          }
          console.log(`[Pinterest] Using default board ID: ${resolvedBoardId}`);
        }
      }

      // 3. Descargar la imagen a memoria RAM
      const imageBuffer = await this.downloadImage(imageUrl);

      // 4. Aplicar filtros con Sharp
      const processedBase64 = await this.processImage(imageBuffer, filters);

      // Truncar la descripción (límite Pinterest: 800 chars)
      let safeDescription = description || '';
      if (safeDescription.length > 600) {
        safeDescription = safeDescription.substring(0, 597) + '...';
      }

      // 5. Construir el payload para la API de Pinterest
      const payload = {
        title: title || '',
        description: safeDescription,
        link: link || '',
        board_id: resolvedBoardId,
        media_source: {
          source_type: 'image_base64',
          content_type: 'image/jpeg',
          data: processedBase64
        }
      };

      // 5. Enviar a Pinterest
      const response = await fetch(`${this.baseUrl}/pins`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Error de Pinterest: ${errorData}`);
      }

      const pinData = await response.json();
      return { success: true, id: pinData.id, pinId: pinData.id, url: `https://pinterest.com/pin/${pinData.id}` };

    } catch (error) {
      console.error('Error publicando el Pin:', error.message);
      throw error;
    }
  }

  /**
   * Descarga la imagen desde una URL y la devuelve como Buffer
   */
  async downloadImage(url) {
    try {
      // 1. Intentar resolver la imagen de manera local en el disco para evitar peticiones HTTP a localhost
      let relativePath = null;

      // Caso A: Si es una URL completa que tiene "/uploads/"
      if (url.includes('/uploads/')) {
        const parts = url.split('/uploads/');
        if (parts.length > 1) {
          relativePath = path.join('uploads', parts[1].replace(/\\/g, '/'));
        }
      }
      // Caso B: Si es una ruta relativa directa
      else if (!url.startsWith('http')) {
        relativePath = url.replace(/^\\+|^\/+/, '');
        if (!relativePath.startsWith('uploads')) {
          relativePath = path.join('uploads', relativePath);
        }
      }

      if (relativePath) {
        const absolutePath = path.resolve(relativePath);
        console.log(`[Pinterest Publisher] Intentando leer imagen localmente en disco: ${absolutePath}`);
        if (fs.existsSync(absolutePath)) {
          return fs.readFileSync(absolutePath);
        }
        console.warn(`[Pinterest Publisher] Archivo local no encontrado en disco en: ${absolutePath}. Intentando descarga vía HTTP...`);
      }

      // 2. Si no es local o no se encontró en disco, descargar vía HTTP
      const fullUrl = url.startsWith('http') ? url : `http://localhost:${process.env.PORT || 3001}${url}`;
      console.log(`[Pinterest Publisher] Descargando imagen por HTTP: ${fullUrl}`);
      const response = await fetch(fullUrl);
      if (!response.ok) {
        throw new Error(`No se pudo descargar la imagen original desde: ${fullUrl}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch (err) {
      console.error(`[Pinterest Publisher] Error en downloadImage para ${url}:`, err.message);
      throw new Error(`No se pudo descargar la imagen original desde: ${url}. Detalle: ${err.message}`);
    }
  }

  /**
   * Muta la imagen usando Sharp y devuelve el Base64 listo para Pinterest
   */
  async processImage(buffer, filters) {
    let imageProcessor = sharp(buffer);

    // Obtener metadatos (dimensiones originales)
    const metadata = await imageProcessor.metadata();

    // 1. Espejo (Flip)
    if (filters.flip) {
      imageProcessor = imageProcessor.flop(); // flop() voltea horizontalmente
    }

    // 2. Micro-Zoom (Recorta el borde)
    if (filters.zoom && filters.zoom > 1.0) {
      const zoomFactor = filters.zoom; // ej: 1.05 (5% de zoom)
      const newWidth = Math.floor(metadata.width / zoomFactor);
      const newHeight = Math.floor(metadata.height / zoomFactor);
      
      const left = Math.floor((metadata.width - newWidth) / 2);
      const top = Math.floor((metadata.height - newHeight) / 2);

      imageProcessor = imageProcessor.extract({ left, top, width: newWidth, height: newHeight });
    }

    // 3. Rotación
    if (filters.rotate && filters.rotate !== 0) {
      // Rotar y recortar para evitar fondos negros en las esquinas
      imageProcessor = imageProcessor.rotate(filters.rotate);
      // Para simplificar, podemos hacer un crop ligero adicional si rotamos,
      // pero Sharp permite recortar con background o simplemente rotar.
    }

    // Convertir a JPEG para estandarizar y exportar a base64
    const finalBuffer = await imageProcessor
      .jpeg({ quality: 90 }) // Calidad óptima para SEO web
      .toBuffer();

    return finalBuffer.toString('base64');
  }

  // Helper para buscar o resolver el tablero por defecto (evita crear tableros por categoría)
  async findOrCreateDefaultBoard(defaultName, accessToken) {
    try {
      console.log(`[Pinterest] Looking for default board: "${defaultName}"...`);
      const response = await fetch(`${this.baseUrl}/boards`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Error de Pinterest al listar tableros (HTTP ${response.status}): ${errText}`);
      }
      
      const data = await response.json();
      const boards = data.items || [];
      console.log(`[Pinterest] Found ${boards.length} boards:`, boards.map(b => b.name));
      
      // 1. Buscar tablero con nombre exacto (ej. "STL Hub")
      const exactBoard = boards.find(b => 
        b.name.toLowerCase() === defaultName.toLowerCase()
      );
      if (exactBoard) {
        console.log(`[Pinterest] Using exact default board: ${exactBoard.id} (${exactBoard.name})`);
        return exactBoard.id;
      }

      // 2. Fallback: Si no existe, pero hay otros tableros, usar el primero disponible
      if (boards.length > 0) {
        console.log(`[Pinterest] Default board "${defaultName}" not found. Using first available board: ${boards[0].id} (${boards[0].name})`);
        return boards[0].id;
      }

      // 3. Si no hay ningún tablero, intentar crear "STL Hub"
      console.log(`[Pinterest] No boards found. Creating default board: "${defaultName}"...`);
      const createResponse = await fetch(`${this.baseUrl}/boards`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: defaultName, description: `3D Printable STL Files` })
      });

      if (!createResponse.ok) {
        const createErrText = await createResponse.text();
        throw new Error(`Error de Pinterest al crear tablero (HTTP ${createResponse.status}): ${createErrText}`);
      }

      const newBoard = await createResponse.json();
      console.log(`[Pinterest] Created default board: ${newBoard.id}`);
      return newBoard.id;
    } catch (e) {
      console.error('[Pinterest] Error resolving default board:', e.message);
      throw e;
    }
  }

  // Helper para buscar un tablero en Pinterest por su nombre exacto
  async findBoardByName(boardName, accessToken) {
    try {
      console.log(`[Pinterest] Looking for board by name: "${boardName}"...`);
      const response = await fetch(`${this.baseUrl}/boards`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[Pinterest] Error listing boards for name match (HTTP ${response.status}): ${errText}`);
        return null;
      }
      const data = await response.json();
      const boards = data.items || [];
      const exactBoard = boards.find(b => 
        b.name.toLowerCase() === boardName.toLowerCase()
      );
      if (exactBoard) {
        return exactBoard.id;
      }
      return null;
    } catch (e) {
      console.error('[Pinterest] Error in findBoardByName:', e.message);
      return null;
    }
  }

  // Helper para buscar el tablero basado en la categoría (se mantiene para compatibilidad)
  async findOrCreateBoard(categoryName, accessToken) {
    try {
      console.log(`[Pinterest] Looking for board: "${categoryName}"...`);
      const response = await fetch(`${this.baseUrl}/boards`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      const responseText = await response.text();
      console.log(`[Pinterest] Boards response (${response.status}):`, responseText.substring(0, 500));
      
      if (response.ok) {
        const data = JSON.parse(responseText);
        const boards = data.items || [];
        console.log(`[Pinterest] Found ${boards.length} boards:`, boards.map(b => b.name));
        
        const existingBoard = boards.find(b => 
          b.name.toLowerCase() === categoryName.toLowerCase() || 
          b.name.toLowerCase().startsWith(categoryName.toLowerCase())
        );
        if (existingBoard) {
          console.log(`[Pinterest] Using existing board: ${existingBoard.id} (${existingBoard.name})`);
          return existingBoard.id;
        }
      }

      // Try to create
      console.log(`[Pinterest] Creating board: "${categoryName}"...`);
      const createResponse = await fetch(`${this.baseUrl}/boards`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: categoryName, description: `3D Printable STL Files - ${categoryName}` })
      });

      const createText = await createResponse.text();
      console.log(`[Pinterest] Create board response (${createResponse.status}):`, createText.substring(0, 500));
      
      if (createResponse.ok) {
        const newBoard = JSON.parse(createText);
        console.log(`[Pinterest] Created board: ${newBoard.id}`);
        return newBoard.id;
      }

      // Board already exists but not in list (sandbox quirk) — get it by slug
      const createData = JSON.parse(createText);
      if (createData.code === 58) {
        console.log(`[Pinterest] Board exists but hidden. Fetching by slug...`);
        const userResp = await fetch(`${this.baseUrl}/user_account`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (userResp.ok) {
          const user = await userResp.json();
          const username = user.username;
          // Try multiple slug formats
          const slugs = [
            categoryName.toLowerCase().replace(/\s+/g, '-'),
            categoryName.toLowerCase().replace(/\s+/g, ''),
            categoryName.toLowerCase().replace(/\s+/g, '_'),
          ];
          for (const slug of slugs) {
            console.log(`[Pinterest] Trying GET /boards/${username}/${slug}`);
            const boardResp = await fetch(`${this.baseUrl}/boards/${username}/${slug}`, {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (boardResp.ok) {
              const board = await boardResp.json();
              console.log(`[Pinterest] Found board by slug: ${board.id}`);
              return board.id;
            }
          }
        }

        // Last resort: create with alternate name
        const altName = `${categoryName} Pins`;
        console.log(`[Pinterest] Trying alternate name: "${altName}"`);
        const altResp = await fetch(`${this.baseUrl}/boards`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: altName, description: `3D Printable STL Files` })
        });
        const altText = await altResp.text();
        console.log(`[Pinterest] Alternate create (${altResp.status}):`, altText.substring(0, 300));
        if (altResp.ok) {
          const altBoard = JSON.parse(altText);
          return altBoard.id;
        }
      }

      console.error(`[Pinterest] Could not find or create board`);
      return null;

    } catch (e) {
      console.error('[Pinterest] Error finding/creating board:', e.message);
      return null;
    }
  }
  /**
   * Tablero para un pin: el de la categoría del asset si existe en Pinterest; si no, el tablero por defecto.
   */
  async resolveBoardForAsset(assetId, accessToken) {
    if (assetId) {
      try {
        const dbAsset = await prisma.asset.findUnique({ where: { id: Number(assetId) }, include: { categories: true } });
        const categoryName = dbAsset?.categories?.[0]?.name;
        if (categoryName) {
          const matched = await this.findBoardByName(categoryName, accessToken);
          if (matched) return matched;
        }
      } catch (e) {
        console.error('[Pinterest Publisher] Error buscando categoría de asset:', e.message);
      }
    }
    const fallback = await this.findOrCreateDefaultBoard('STL Hub', accessToken);
    if (!fallback) throw new Error('No se pudo obtener ningún tablero de Pinterest. Crea al menos un tablero en tu cuenta.');
    return fallback;
  }

  /**
   * Pin de video (reels): registra el video en Pinterest, lo sube, espera a que lo procese y crea el pin.
   * @param {Object} params
   * @param {string} params.videoAbsPath Ruta local del .mp4
   * @param {string} params.title Título (máx. 100)
   * @param {string} params.description Descripción (máx. 500)
   * @param {string} params.link URL a la que lleva el pin
   * @param {number|null} params.assetId Asset para elegir el tablero por su categoría
   * @param {number} params.coverSeconds Segundo del video que se usa como portada
   */
  async publishVideoPin({ videoAbsPath, title, description, link, assetId = null, coverSeconds = 1 }) {
    if (!videoAbsPath || !fs.existsSync(videoAbsPath)) throw new Error('El archivo de video no está en el servidor');
    const accessToken = await pinterestService.getValidAccessToken();
    const auth = { Authorization: `Bearer ${accessToken}` };
    const boardId = await this.resolveBoardForAsset(assetId, accessToken);

    // 1. Registrar la subida
    const regResp = await fetch(`${this.baseUrl}/media`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ media_type: 'video' }),
    });
    const reg = await regResp.json().catch(() => ({}));
    if (!regResp.ok || !reg.media_id || !reg.upload_url) {
      throw new Error(`Pinterest no aceptó registrar el video: ${reg.message || `HTTP ${regResp.status}`}`);
    }

    // 2. Subir el archivo al almacenamiento que indica Pinterest (formulario con sus parámetros + el archivo)
    const form = new FormData();
    for (const [key, value] of Object.entries(reg.upload_parameters || {})) form.append(key, value);
    const buffer = await fs.promises.readFile(videoAbsPath);
    form.append('file', new Blob([buffer], { type: 'video/mp4' }), path.basename(videoAbsPath));
    const upResp = await fetch(reg.upload_url, { method: 'POST', body: form });
    if (!upResp.ok) {
      const text = await upResp.text().catch(() => '');
      throw new Error(`No se pudo subir el video a Pinterest (HTTP ${upResp.status}) ${text.slice(0, 200)}`);
    }

    // 3. Esperar a que Pinterest procese el video (hasta ~10 min)
    let status = 'registered';
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const stResp = await fetch(`${this.baseUrl}/media/${reg.media_id}`, { headers: auth });
      const st = await stResp.json().catch(() => ({}));
      status = st.status || status;
      if (status === 'succeeded') break;
      if (status === 'failed') throw new Error('Pinterest no pudo procesar el video');
    }
    if (status !== 'succeeded') throw new Error('Pinterest tardó demasiado en procesar el video');

    // 4. Crear el pin con el video
    const payload = {
      board_id: boardId,
      title: String(title || '').slice(0, 100),
      description: String(description || '').slice(0, 500),
      link: link || '',
      media_source: { source_type: 'video_id', media_id: reg.media_id, cover_image_key_frame_time: coverSeconds },
    };
    const pinResp = await fetch(`${this.baseUrl}/pins`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!pinResp.ok) {
      const text = await pinResp.text().catch(() => '');
      throw new Error(`Error de Pinterest al crear el pin de video: ${text.slice(0, 300)}`);
    }
    const pin = await pinResp.json();
    return { id: pin.id, pinId: pin.id, boardId, url: `https://www.pinterest.com/pin/${pin.id}/` };
  }
}

export default new PinterestPublisherService();
