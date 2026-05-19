import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

class PinterestService {
  constructor() {
    this.clientId = process.env.PINTEREST_CLIENT_ID;
    this.clientSecret = process.env.PINTEREST_CLIENT_SECRET;
    this.redirectUri = process.env.PINTEREST_REDIRECT_URI || 'http://localhost:3001/api/pinterest/callback';
    this.baseUrl = 'https://api.pinterest.com/v5';
  }

  // 1. Generar la URL de autorización para iniciar el flujo OAuth
  getAuthUrl() {
    const scopes = 'boards:read,boards:write,pins:read,pins:write,user_accounts:read';
    // Generar un state aleatorio para seguridad (CSRF)
    const state = Math.random().toString(36).substring(7);
    
    return `https://www.pinterest.com/oauth/?client_id=${this.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code&scope=${scopes}&state=${state}`;
  }

  // 2. Intercambiar el código devuelto por Pinterest por los tokens
  async exchangeCodeForToken(code) {
    try {
      const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: this.redirectUri
        }).toString()
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(errorData);
      }

      const data = await response.json();
      const { access_token, refresh_token, expires_in, refresh_token_expires_in } = data;

      // Calcular fechas de expiración
      const accessTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
      const refreshTokenExpiresAt = new Date(Date.now() + refresh_token_expires_in * 1000);

      // Guardar en la base de datos (SystemSetting)
      await this.saveTokens(access_token, refresh_token, accessTokenExpiresAt, refreshTokenExpiresAt);

      return { success: true };
    } catch (error) {
      console.error('Error intercambiando código de Pinterest:', error.message);
      throw new Error('No se pudo obtener el token de Pinterest');
    }
  }

  // 3. Obtener el Access Token actual, refrescándolo si es necesario
  async getValidAccessToken() {
    const tokenSettings = await prisma.systemSetting.findMany({
      where: {
        key: {
          in: ['PINTEREST_ACCESS_TOKEN', 'PINTEREST_REFRESH_TOKEN', 'PINTEREST_TOKEN_EXPIRES_AT']
        }
      }
    });

    const settingsMap = tokenSettings.reduce((acc, curr) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});

    const accessToken = settingsMap['PINTEREST_ACCESS_TOKEN'];
    const refreshToken = settingsMap['PINTEREST_REFRESH_TOKEN'];
    const expiresAt = settingsMap['PINTEREST_TOKEN_EXPIRES_AT'];

    if (!accessToken || !refreshToken) {
      throw new Error('Pinterest no está conectado. Requiere autenticación OAuth.');
    }

    // Comprobar si el access token expiró o expira en los próximos 5 minutos
    const expirationDate = new Date(expiresAt);
    if (Date.now() >= (expirationDate.getTime() - 5 * 60 * 1000)) {
      console.log('El Access Token de Pinterest expiró o está por expirar. Refrescando...');
      return await this.refreshAccessToken(refreshToken);
    }

    return accessToken;
  }

  // 4. Refrescar el Access Token usando el Refresh Token
  async refreshAccessToken(refreshToken) {
    try {
      const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      
      const response = await fetch(`${this.baseUrl}/oauth/token`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }).toString()
      });

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(errorData);
      }

      const data = await response.json();
      const { access_token, refresh_token: new_refresh_token, expires_in, refresh_token_expires_in } = data;
      
      const finalRefreshToken = new_refresh_token || refreshToken; // A veces no devuelven uno nuevo

      const accessTokenExpiresAt = new Date(Date.now() + expires_in * 1000);
      const refreshTokenExpiresAt = refresh_token_expires_in 
        ? new Date(Date.now() + refresh_token_expires_in * 1000)
        : null;

      await this.saveTokens(access_token, finalRefreshToken, accessTokenExpiresAt, refreshTokenExpiresAt);

      return access_token;
    } catch (error) {
      console.error('Error refrescando token de Pinterest:', error.message);
      throw new Error('No se pudo refrescar el token de Pinterest. El usuario debe volver a iniciar sesión.');
    }
  }

  // Helper: Guardar tokens en SystemSetting
  async saveTokens(accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt) {
    const dataToSave = [
      { key: 'PINTEREST_ACCESS_TOKEN', value: accessToken },
      { key: 'PINTEREST_REFRESH_TOKEN', value: refreshToken },
      { key: 'PINTEREST_TOKEN_EXPIRES_AT', value: accessTokenExpiresAt.toISOString() }
    ];

    if (refreshTokenExpiresAt) {
      dataToSave.push({ key: 'PINTEREST_REFRESH_EXPIRES_AT', value: refreshTokenExpiresAt.toISOString() });
    }

    for (const item of dataToSave) {
      await prisma.systemSetting.upsert({
        where: { key: item.key },
        update: { value: item.value },
        create: { key: item.key, value: item.value, description: 'Pinterest OAuth Token' }
      });
    }
  }

  // Test de conexión (para verificar si la cuenta está enlazada)
  async testConnection() {
    try {
      const token = await this.getValidAccessToken();
      const response = await fetch(`${this.baseUrl}/user_account`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        throw new Error('No se pudo verificar la cuenta con Pinterest');
      }

      const data = await response.json();
      return { 
        connected: true, 
        account: data 
      };
    } catch (error) {
      return { 
        connected: false, 
        message: error.message 
      };
    }
  }
}

export default new PinterestService();
