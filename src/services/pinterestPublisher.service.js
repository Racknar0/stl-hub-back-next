import sharp from 'sharp';
import pinterestService from './pinterest.service.js';

class PinterestPublisherService {
  constructor() {
    this.baseUrl = 'https://api.pinterest.com/v5';
  }

  /**
   * Procesa la imagen, aplica filtros y la envía a Pinterest
   * @param {string} imageUrl URL original de la imagen
   * @param {string} boardId ID del tablero de Pinterest
   * @param {string} title Título del Pin
   * @param {string} description Descripción del Pin
   * @param {string} link URL a donde lleva el Pin (ej. la página del asset)
   * @param {Object} filters Configuración de filtros { flip: true, zoom: 1.05, rotate: 2 }
   */
  async publishPin(imageUrl, boardId, title, description, link, filters = {}) {
    try {
      // 1. Obtener un token de acceso válido
      const accessToken = await pinterestService.getValidAccessToken();

      // 2. Descargar la imagen a memoria RAM
      const imageBuffer = await this.downloadImage(imageUrl);

      // 3. Aplicar filtros con Sharp
      const processedBase64 = await this.processImage(imageBuffer, filters);

      // Truncar la descripción para no romper el límite de 800 caracteres de Pinterest
      // Dejamos un máximo de 600 caracteres para asegurar que quepan los hashtags.
      let safeDescription = description || '';
      if (safeDescription.length > 600) {
        safeDescription = safeDescription.substring(0, 597) + '...';
      }

      // 4. Construir el payload para la API de Pinterest
      const payload = {
        title: title || '',
        description: safeDescription,
        link: link || '',
        board_id: boardId,
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
      return { success: true, pinId: pinData.id, url: `https://pinterest.com/pin/${pinData.id}` };

    } catch (error) {
      console.error('Error publicando el Pin:', error.message);
      throw error;
    }
  }

  /**
   * Descarga la imagen desde una URL y la devuelve como Buffer
   */
  async downloadImage(url) {
    // Si la URL es una ruta local (ej: /uploads/...), asumimos que el backend 
    // la sirve localmente. Para simplificar, la consumimos vía HTTP si tenemos la URL base,
    // o podríamos leerla con `fs` si es estrictamente local.
    // Ajustaremos esto si las imágenes vienen por URL relativa.
    const fullUrl = url.startsWith('http') ? url : `http://localhost:${process.env.PORT || 3001}${url}`;
    
    const response = await fetch(fullUrl);
    if (!response.ok) {
      throw new Error(`No se pudo descargar la imagen original desde: ${fullUrl}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
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

  // Helper para buscar el tablero basado en la categoría
  async findOrCreateBoard(categoryName, accessToken) {
    try {
      // Pedimos la lista de tableros del usuario
      const response = await fetch(`${this.baseUrl}/boards`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) return null;
      
      const data = await response.json();
      const boards = data.items || [];
      
      // Buscar tablero por nombre ignorando mayúsculas
      const existingBoard = boards.find(b => b.name.toLowerCase() === categoryName.toLowerCase());
      if (existingBoard) {
        return existingBoard.id;
      }

      // Si no existe, crearlo
      const createResponse = await fetch(`${this.baseUrl}/boards`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: categoryName,
          description: `Tablero oficial de STL Hub para modelos 3D de la categoría ${categoryName}`
        })
      });

      if (!createResponse.ok) return null;
      
      const newBoard = await createResponse.json();
      return newBoard.id;

    } catch (e) {
      console.error('Error buscando/creando tablero:', e.message);
      return null;
    }
  }
}

export default new PinterestPublisherService();
