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
        const boardName = 'STL Hub';
        resolvedBoardId = await this.findOrCreateDefaultBoard(boardName, accessToken);
        if (!resolvedBoardId) {
          throw new Error('No se pudo obtener ningún tablero predeterminado de Pinterest. Crea al menos un tablero en tu cuenta de Pinterest manualmente.');
        }
        console.log(`[Pinterest] Using default board ID: ${resolvedBoardId}`);
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
}

export default new PinterestPublisherService();
