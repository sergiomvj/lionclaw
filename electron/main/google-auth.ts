import { google } from 'googleapis';
import http from 'http';
import { URL } from 'url';
import { shell } from 'electron';
import { getSecret, setSecret, deleteSecret } from './secrets-vault';
import { createLogger } from './logger';

const logger = createLogger('google-auth');

const ALL_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/youtube.readonly',
];

/**
 * Executa o OAuth flow completo:
 * 1. Abre servidor HTTP loopback
 * 2. Abre browser com URL de consentimento
 * 3. Captura callback com auth code
 * 4. Troca code por tokens
 * 5. Salva tokens no vault
 */
export async function runOAuthFlow(): Promise<{ success: boolean; error?: string }> {
  const clientId = await getSecret('GOOGLE_CLIENT_ID');
  const clientSecret = await getSecret('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    return { success: false, error: 'Configure Client ID e Client Secret primeiro' };
  }

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, `http://localhost`);
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autenticacao cancelada</h2><p>Voce pode fechar esta aba.</p></body></html>');
          server.close();
          resolve({ success: false, error: `Google retornou erro: ${error}` });
          return;
        }

        if (code) {
          // Capturar porta ANTES de fechar o server
          const port = (server.address() as { port: number }).port;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body style="font-family:sans-serif;text-align:center;padding:60px"><h2>Autenticacao concluida!</h2><p>Pode fechar esta aba e voltar ao LionClaw.</p></body></html>');
          server.close();

          try {
            const oauth2Client = new google.auth.OAuth2(
              clientId, clientSecret, `http://localhost:${port}`,
            );
            const { tokens } = await oauth2Client.getToken(code);

            if (tokens.refresh_token) {
              await setSecret('GOOGLE_REFRESH_TOKEN', tokens.refresh_token);
            }
            if (tokens.access_token) {
              await setSecret('GOOGLE_ACCESS_TOKEN', tokens.access_token);
            }

            logger.info('Google OAuth: tokens salvos no vault');
            resolve({ success: true });
          } catch (err) {
            logger.error({ err }, 'Google OAuth: falha ao trocar code por tokens');
            resolve({ success: false, error: (err as Error).message });
          }
        }
      } catch (err) {
        logger.error({ err }, 'Google OAuth: erro no callback handler');
        server.close();
        resolve({ success: false, error: (err as Error).message });
      }
    });

    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      const oauth2Client = new google.auth.OAuth2(
        clientId, clientSecret, `http://localhost:${port}`,
      );
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ALL_SCOPES,
        prompt: 'consent',
      });

      shell.openExternal(authUrl);
      logger.info({ port }, 'Google OAuth: aguardando callback');
    });

    // Timeout 2 minutos
    setTimeout(() => {
      server.close();
      resolve({ success: false, error: 'Timeout: autenticacao nao completada em 2 minutos' });
    }, 120_000);
  });
}

/**
 * Verifica status da autenticacao Google.
 */
export async function getGoogleAuthStatus(): Promise<{
  hasCredentials: boolean;
  isAuthenticated: boolean;
}> {
  const clientId = await getSecret('GOOGLE_CLIENT_ID');
  const clientSecret = await getSecret('GOOGLE_CLIENT_SECRET');
  const refreshToken = await getSecret('GOOGLE_REFRESH_TOKEN');

  return {
    hasCredentials: !!(clientId && clientSecret),
    isAuthenticated: !!refreshToken,
  };
}

/**
 * Revogar acesso Google e limpar todos os tokens do vault.
 */
export async function revokeGoogleAuth(): Promise<void> {
  const accessToken = await getSecret('GOOGLE_ACCESS_TOKEN');

  if (accessToken) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, {
        method: 'POST',
      });
    } catch {
      // Ignorar erro de revogacao - limpar local de qualquer forma
    }
  }

  await deleteSecret('GOOGLE_REFRESH_TOKEN');
  await deleteSecret('GOOGLE_ACCESS_TOKEN');
  logger.info('Google OAuth: tokens revogados e removidos do vault');
}
