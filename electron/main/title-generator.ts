import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './secrets-vault';
import { updateSessionTitle, getSessionMessages } from './db';
import { createLogger } from './logger';

const logger = createLogger('title-generator');

/**
 * Gera um titulo curto e descritivo para uma sessao de chat
 * usando uma chamada one-shot ao haiku (barato e rapido).
 *
 * Chamado automaticamente apos N mensagens na sessao.
 */
export async function generateSessionTitle(sessionId: string): Promise<void> {
  try {
    const messages = getSessionMessages(sessionId);
    if (messages.length < 2) return; // Precisa de pelo menos 1 pergunta + 1 resposta

    // Pegar as primeiras mensagens (max 6) pra contexto
    const contextMessages = messages.slice(0, 6);
    const conversationSnippet = contextMessages
      .map((m) => `${m.role === 'user' ? 'Usuario' : 'Assistente'}: ${m.content.substring(0, 300)}`)
      .join('\n\n');

    const apiKey = await getApiKey();
    if (!apiKey) return;

    const client = new Anthropic({ apiKey });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 60,
      messages: [
        {
          role: 'user',
          content: `Analise esta conversa e gere um titulo CURTO (3-6 palavras, maximo 50 caracteres) em portugues brasileiro que resuma o tema principal. Retorne APENAS o titulo, sem aspas, sem pontuacao final, sem explicacao.

Conversa:
${conversationSnippet}

Titulo:`,
        },
      ],
    });

    let titleText = response.content[0]?.type === 'text'
      ? response.content[0].text
      : null;

    if (!titleText) return;

    // Limpar o titulo
    titleText = titleText
      .trim()
      .replace(/^["']|["']$/g, '')  // Remover aspas
      .replace(/\.+$/, '')           // Remover pontos finais
      .replace(/^titulo:\s*/i, '')   // Remover prefixo "Titulo:"
      .substring(0, 60);            // Limitar tamanho

    if (!titleText || titleText.length < 3) {
      logger.warn({ sessionId }, 'Title generation returned empty/short result, skipping');
      return;
    }

    // Atualizar no banco
    updateSessionTitle(sessionId, titleText);
    logger.info({ sessionId, title: titleText }, 'Session title generated');

    // Notifica renderer para recarregar lista de sessoes
    const { BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('chat:sessions-updated');
    }
  } catch (error) {
    // Falha silenciosa - titulo eh cosmetic, nao deve quebrar o chat
    logger.error({ error, sessionId }, 'Failed to generate session title');
  }
}
