import TelegramBot from 'node-telegram-bot-api';
import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import { getDb, createSession } from './db';
import { executeQuery } from './orchestrator';
import { getSecret } from './secrets-vault';
import { updateChannelStatus } from './channels-db';
import { createLogger } from './logger';
import { getAllScheduledTasks, getPendingReviewCount } from './scheduler';
import { transcribeAudio } from './voice-engine';
import fs from 'fs';
import path from 'path';

const logger = createLogger('telegram');

let bot: TelegramBot | null = null;
let getWindowFn: (() => BrowserWindow | null) | null = null;
let activeSessionId: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let isStarting = false;
const MAX_RECONNECT_DELAY_MS = 60_000;
const CONFLICT_COOLDOWN_MS = 15_000;
const MAX_CONFLICT_RETRIES = 3;
let conflictRetries = 0;
const processedMessageIds = new Set<string>();
const MAX_PROCESSED_IDS = 500;

interface TelegramConfig {
  allowedUserId: number;
  allowedUserName: string;
  botUsername?: string;
  sessionMode: 'continuous' | 'per-message';
  notifyOnSchedulerTasks: boolean;
}

export async function startTelegramBot(
  getWindow: () => BrowserWindow | null,
): Promise<boolean> {
  // Guard against concurrent starts — prevents ghost polling instances
  if (isStarting) {
    logger.warn('Telegram: startTelegramBot already in progress, skipping');
    return false;
  }

  // Always stop existing bot before creating a new one
  if (bot) {
    logger.info('Telegram: stopping existing bot before restart');
    const oldBot = bot;
    bot = null;
    try {
      await oldBot.stopPolling({ cancel: true });
    } catch { /* ignore */ }
    // Give Telegram API time to release the connection
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  isStarting = true;
  getWindowFn = getWindow;

  const token = await getSecret('TELEGRAM_BOT_TOKEN');
  if (!token) {
    logger.warn('Telegram bot token not configured, skipping');
    isStarting = false;
    return false;
  }

  const config = getTelegramConfig();
  if (!config || !config.allowedUserId) {
    logger.warn('Telegram allowedUserId not configured, skipping');
    isStarting = false;
    return false;
  }

  const allowedUserId = config.allowedUserId;

  try {
    // Light cleanup: just delete webhook (no-op if none set).
    // Avoids the fragile getUpdates trick that fails on network issues.
    try {
      const cleanupBot = new TelegramBot(token, { polling: false });
      await Promise.race([
        cleanupBot.deleteWebHook({ drop_pending_updates: true }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('deleteWebHook timed out')), 5_000),
        ),
      ]);
    } catch (e) {
      logger.debug({ error: e }, 'Telegram: pre-start cleanup (non-fatal)');
    }

    bot = new TelegramBot(token, { polling: true });

    bot.on('message', async (msg) => {
      // Dedup: skip already-processed messages (prevents duplicates on reconnect)
      // Key includes chat.id because message_id is only unique per chat in Telegram
      const dedupKey = `${msg.chat.id}:${msg.message_id}`;
      if (processedMessageIds.has(dedupKey)) {
        logger.debug({ messageId: msg.message_id, chatId: msg.chat.id }, 'Telegram: duplicate message, skipping');
        return;
      }
      processedMessageIds.add(dedupKey);
      if (processedMessageIds.size > MAX_PROCESSED_IDS) {
        const oldest = processedMessageIds.values().next().value;
        if (oldest !== undefined) processedMessageIds.delete(oldest);
      }

      if (!msg.from?.id || msg.from.id !== allowedUserId) {
        logger.warn({ fromId: msg.from?.id }, 'Telegram: unauthorized user, ignoring');
        return;
      }

      const userName = config.allowedUserName || msg.from?.first_name || 'Usuario';

      // Handle voice messages — transcribe and process as text
      if (msg.voice) {
        logger.info({ duration: msg.voice.duration, user: userName }, 'Telegram: voice message received');

        try {
          await bot!.sendChatAction(msg.chat.id, 'typing');

          const fileLink = await bot!.getFileLink(msg.voice.file_id);
          const audioResponse = await fetch(fileLink);
          const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
          const audioBase64 = audioBuffer.toString('base64');

          const transcribedText = await transcribeAudio(audioBase64, 'ogg');

          if (!transcribedText.trim()) {
            await bot!.sendMessage(msg.chat.id, 'Nao consegui entender o audio. Tente novamente.');
            return;
          }

          logger.info({ text: transcribedText.substring(0, 50) }, 'Telegram: voice transcribed');

          const sessionId = getOrCreateTelegramSession();
          const response = await executeTelegramQuery(transcribedText, sessionId, msg.chat.id, userName);
          await sendTelegramResponse(msg.chat.id, response);
        } catch (error) {
          logger.error({ error }, 'Telegram: voice processing failed');
          await bot!.sendMessage(msg.chat.id, 'Erro ao processar audio.');
        }
        return;
      }

      const text = msg.text;
      if (!text) return;

      // Intercept bot commands
      if (text.startsWith('/')) {
        await handleBotCommand(text, msg.chat.id, config);
        return;
      }

      logger.info({ text: text.substring(0, 50), user: userName }, 'Telegram: message received');

      try {
        await bot!.sendChatAction(msg.chat.id, 'typing');

        const sessionId = getOrCreateTelegramSession();
        const response = await executeTelegramQuery(text, sessionId, msg.chat.id, userName);
        await sendTelegramResponse(msg.chat.id, response);
      } catch (error) {
        logger.error({ error }, 'Telegram: query failed');
        await bot!.sendMessage(msg.chat.id, 'Erro ao processar sua mensagem. Tente novamente.');
      }
    });

    // Block all other event types from unauthorized users
    bot.on('callback_query', (query) => {
      if (query.from.id !== allowedUserId) return;
      bot!.answerCallbackQuery(query.id).catch(() => {});
    });

    bot.on('inline_query', (query) => {
      if (query.from.id !== allowedUserId) return;
    });

    bot.on('polling_error', async (error) => {
      const msg = error.message || String(error);
      const is409 = msg.includes('409') || msg.includes('Conflict');

      // Network errors (ENOTFOUND, ECONNRESET, EFATAL) — the lib retries internally.
      // Just log and let it recover on its own. Do NOT reconnect (creates duplicate instances).
      if (!is409) {
        logger.warn({ error: msg }, 'Telegram: transient polling error (lib will retry)');
        return;
      }

      // 409 Conflict — another polling instance exists. Stop and reconnect with cooldown.
      conflictRetries++;
      logger.error({ attempt: conflictRetries, max: MAX_CONFLICT_RETRIES }, 'Telegram: 409 Conflict detected, stopping polling');
      updateChannelStatus('telegram', 'error', 'Conflict: another instance running');

      if (bot) {
        const oldBot = bot;
        bot = null;
        try { await oldBot.stopPolling({ cancel: true }); } catch { /* ignore */ }
      }

      if (conflictRetries >= MAX_CONFLICT_RETRIES) {
        logger.error('Telegram: max conflict retries reached, giving up. Restart the app to retry.');
        updateChannelStatus('telegram', 'error', 'Conflict loop: stopped after max retries');
        return;
      }

      scheduleReconnect(CONFLICT_COOLDOWN_MS);
    });

    updateChannelStatus('telegram', 'connected');
    logger.info('Telegram bot started');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    updateChannelStatus('telegram', 'error', msg);
    logger.error({ error }, 'Telegram bot failed to start');
    return false;
  } finally {
    isStarting = false;
  }
}

function scheduleReconnect(extraDelayMs = 0): void {
  if (reconnectTimer) return;
  reconnectAttempts++;
  const baseDelay = Math.min(5_000 * reconnectAttempts, MAX_RECONNECT_DELAY_MS);
  const delay = baseDelay + extraDelayMs;
  logger.info({ attempt: reconnectAttempts, delayMs: delay }, 'Telegram: scheduling reconnect');

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!getWindowFn) return;
    logger.info('Telegram: attempting reconnect');
    try {
      if (bot) {
        const oldBot = bot;
        bot = null;
        try {
          await oldBot.stopPolling({ cancel: true });
        } catch { /* ignore */ }
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      const started = await startTelegramBot(getWindowFn);
      if (!started) {
        logger.error('Telegram: reconnect attempt failed, will retry');
        scheduleReconnect();
        return;
      }
      reconnectAttempts = 0;
      conflictRetries = 0;
      logger.info('Telegram: reconnected successfully');
    } catch (err) {
      logger.error({ err }, 'Telegram: reconnect failed, will retry');
      scheduleReconnect();
    }
  }, delay);
}

export async function stopTelegramBot(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  conflictRetries = 0;
  isStarting = false;
  if (bot) {
    const oldBot = bot;
    bot = null;
    try { await oldBot.stopPolling({ cancel: true }); } catch { /* ignore */ }
    // Give Telegram API time to release the long-polling connection
    await new Promise(resolve => setTimeout(resolve, 1500));
    updateChannelStatus('telegram', 'disconnected');
    logger.info('Telegram bot stopped');
  }
}

export function isTelegramRunning(): boolean {
  return bot !== null && bot.isPolling();
}

export async function sendTelegramNotification(text: string): Promise<void> {
  if (!bot) return;

  const config = getTelegramConfig();
  if (!config?.allowedUserId) return;

  try {
    await sendTelegramResponse(config.allowedUserId, text);
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram notification');
  }
}

export async function sendTelegramPhoto(
  chatId: number,
  base64: string,
  mimeType: string,
  caption?: string,
): Promise<void> {
  if (!bot) return;

  try {
    const buffer = Buffer.from(base64, 'base64');
    const ext = mimeType.includes('png') ? 'png' : 'jpg';

    await bot.sendPhoto(chatId, buffer, {
      caption: caption?.substring(0, 1024),
    }, {
      filename: `image.${ext}`,
      contentType: mimeType,
    });

    logger.info('Telegram: photo sent');
  } catch (error) {
    logger.error({ error }, 'Failed to send Telegram photo');
  }
}

export function isTelegramConfigured(): boolean {
  const config = getTelegramConfig();
  return config !== null && config.notifyOnSchedulerTasks;
}

async function handleBotCommand(text: string, chatId: number, config: TelegramConfig): Promise<void> {
  if (!bot) return;

  const command = text.split(' ')[0].toLowerCase();

  switch (command) {
    case '/reset': {
      activeSessionId = null;
      await bot.sendMessage(chatId, 'Sessao resetada. Proxima mensagem inicia uma conversa nova.');
      break;
    }
    case '/status': {
      const db = getDb();
      const sessionCount = (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE type = 'telegram' AND status = 'active'").get() as { c: number }).c;
      const pendingReviews = getPendingReviewCount();
      const tasks = getAllScheduledTasks().filter(t => t.status === 'active');

      let statusMsg = '== Status do LionClaw ==\n\n';
      statusMsg += `Sessao Telegram ativa: ${activeSessionId ? 'Sim' : 'Nao'}\n`;
      statusMsg += `Sessoes Telegram total: ${sessionCount}\n`;
      statusMsg += `Tasks agendadas ativas: ${tasks.length}\n`;
      statusMsg += `Reviews pendentes: ${pendingReviews}\n`;

      await bot.sendMessage(chatId, statusMsg);
      break;
    }
    case '/tasks': {
      const tasks = getAllScheduledTasks();
      if (tasks.length === 0) {
        await bot.sendMessage(chatId, 'Nenhuma task agendada.');
        break;
      }

      let msg = '== Tasks Agendadas ==\n\n';
      for (const task of tasks) {
        const statusEmoji = task.status === 'active' ? 'ON' : task.status === 'paused' ? 'PAUSA' : 'OK';
        msg += `[${statusEmoji}] ${task.name}\n`;
        if (task.nextRun) msg += `  Proxima: ${new Date(task.nextRun).toLocaleString('pt-BR')}\n`;
        msg += `  Execucoes: ${task.runCount}\n\n`;
      }

      const pendingCount = getPendingReviewCount();
      if (pendingCount > 0) {
        msg += `\n${pendingCount} review(s) pendente(s) no app.`;
      }

      await bot.sendMessage(chatId, msg);
      break;
    }
    default: {
      await bot.sendMessage(chatId, 'Comandos disponiveis:\n/reset - Nova sessao\n/status - Status do sistema\n/tasks - Tasks agendadas');
    }
  }
}

const TELEGRAM_CONTEXT = `[SISTEMA — CANAL TELEGRAM]
Esta conversa acontece pelo Telegram. O usuario esta no celular/desktop do Telegram, NAO no app LionClaw.

## COMO ENVIAR VOZ NO TELEGRAM
Voce tem a tool "text_to_speech" do MCP ElevenLabs. Quando voce a usa, o sistema detecta o audio gerado e envia automaticamente como voice message no Telegram. O usuario recebe e ouve direto no chat.

QUANDO USAR text_to_speech:
- O usuario pede "fala isso", "manda audio", "me responde em voz", "quero ouvir"
- O usuario manda voice message (audio) para voce — responda com text_to_speech tambem
- Qualquer situacao onde audio faz mais sentido que texto

COMO USAR:
- Chame a tool "text_to_speech" com voice_id e o texto que quer falar
- O audio chega automaticamente ao usuario como voice message — voce NAO precisa fazer mais nada
- Para multiplos audios (ex: previews de vozes), chame a tool UMA VEZ POR AUDIO
- NUNCA mencione nomes de arquivo, paths ou ARQUIVO_AUDIO na resposta — o usuario so ve o audio

Para previews/samples de vozes, use "preview_voice" com o voice_id. Mesmo mecanismo.

## IMAGENS
Use as tools normalmente (nano-banana, etc). O sistema envia como foto no Telegram automaticamente.

## REGRAS GERAIS
- NUNCA mencione caminhos de arquivo (C:\\, /tmp/, etc) — o usuario nao tem acesso
- Formatacao: Markdown basico (*negrito*, _italico_). Evite tabelas e blocos de codigo longos.
- Seja conciso — mensagens longas ficam ruins no Telegram
[/SISTEMA]

`;

async function executeTelegramQuery(
  text: string,
  sessionId: string,
  chatId: number,
  userName?: string,
): Promise<string> {
  const userPrefix = userName ? `[Mensagem de: ${userName}]\n` : '';
  const contextualMessage = TELEGRAM_CONTEXT + userPrefix + text;

  // Track last message id before query to detect stale responses
  const db = getDb();
  const lastBefore = db.prepare(
    "SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
  ).get(sessionId) as { id: number } | undefined;
  const lastIdBefore = lastBefore?.id ?? 0;

  await executeQuery(contextualMessage, {
    sessionId,
    silent: true,
    displayMessage: text,
  }, getWindowFn || (() => null));

  const row = db.prepare(
    "SELECT id, content, metadata FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1",
  ).get(sessionId) as { id: number; content: string; metadata?: string } | undefined;

  // If no new assistant message was created, the query likely failed silently
  if (!row || row.id <= lastIdBefore) {
    logger.warn({ sessionId, lastIdBefore }, 'Telegram: no new assistant message after executeQuery — possible silent failure');
    return 'Erro ao processar. Tente novamente.';
  }

  // Check for artifacts (image + audio) in metadata — this is where tool_result data lives
  if (row?.metadata) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.artifacts && bot) {
        for (const artifact of meta.artifacts) {
          // Send image artifacts as photos
          if (artifact.type === 'image' && artifact.data?.imageBase64) {
            await sendTelegramPhoto(
              chatId,
              artifact.data.imageBase64,
              artifact.data.mimeType || 'image/png',
              artifact.data.prompt || 'Imagem gerada',
            );
          }
          // Send audio artifacts as voice messages
          if (artifact.type === 'audio' && artifact.data?.filePath) {
            try {
              const audioPath = artifact.data.filePath;
              if (fs.existsSync(audioPath)) {
                const audioBuffer = fs.readFileSync(audioPath);
                const ext = path.extname(audioPath).toLowerCase();
                const contentType = ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
                const filename = ext === '.ogg' ? 'audio.ogg' : 'audio.mp3';

                await bot.sendVoice(chatId, audioBuffer, {}, { filename, contentType });
                logger.info({ audioPath }, 'Telegram: audio artifact sent as voice');
              }
            } catch (err) {
              logger.warn({ err, filePath: artifact.data.filePath }, 'Failed to send audio artifact via Telegram');
            }
          }
        }
      }
    } catch { /* metadata parse error, ignore */ }
  }

  // Fallback: check for ARQUIVO_IMAGEM pattern directly in content text
  const content = row?.content || 'Sem resposta.';
  const imageMatch = content.match(/ARQUIVO_IMAGEM:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/);
  if (imageMatch) {
    const imagePath = imageMatch[1].trim();
    try {
      if (fs.existsSync(imagePath)) {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const mimeType = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        await sendTelegramPhoto(chatId, base64, mimeType, 'Imagem gerada');
      }
    } catch (err) {
      logger.warn({ err, imagePath }, 'Failed to send generated image via Telegram');
    }
  }

  // Fallback: check for ARQUIVO_AUDIO pattern directly in content text
  const audioMatches = content.matchAll(/ARQUIVO_AUDIO:\s*((?:\/|[A-Za-z]:\\).+?)(?:\n|$)/g);
  for (const audioMatch of audioMatches) {
    const audioPath = audioMatch[1].trim();
    try {
      if (bot && fs.existsSync(audioPath)) {
        const audioBuffer = fs.readFileSync(audioPath);
        const ext = path.extname(audioPath).toLowerCase();
        const contentType = ext === '.ogg' ? 'audio/ogg' : 'audio/mpeg';
        const filename = ext === '.ogg' ? 'audio.ogg' : 'audio.mp3';

        await bot.sendVoice(chatId, audioBuffer, {}, { filename, contentType });
        logger.info({ audioPath }, 'Telegram: audio file sent via content fallback');
      }
    } catch (err) {
      logger.warn({ err, audioPath }, 'Failed to send audio file via Telegram');
    }
  }

  return content;
}

async function sendTelegramResponse(
  chatId: number,
  text: string,
): Promise<void> {
  if (!bot) return;

  const MAX_LENGTH = 4096;

  if (text.length <= MAX_LENGTH) {
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' })
      .catch(() => bot!.sendMessage(chatId, text));
    return;
  }

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', MAX_LENGTH);
    if (cutAt < MAX_LENGTH / 2) cutAt = MAX_LENGTH;
    chunks.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).trimStart();
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' })
      .catch(() => bot!.sendMessage(chatId, chunk));
  }
}

function getOrCreateTelegramSession(): string {
  if (activeSessionId) return activeSessionId;

  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM sessions WHERE type = 'telegram' AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
  ).get() as { id: string } | undefined;

  if (existing) {
    activeSessionId = existing.id;
    return existing.id;
  }

  const id = crypto.randomUUID();
  createSession(id, '[Telegram] Conversa', undefined, { type: 'telegram' });
  activeSessionId = id;
  return id;
}

function getTelegramConfig(): TelegramConfig | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT config FROM channels WHERE type = 'telegram' AND is_active = 1",
  ).get() as { config: string } | undefined;

  if (!row) return null;
  try {
    const raw = JSON.parse(row.config) as Record<string, unknown>;

    // Backward compat: migrate legacy array formats to single user
    let userId = raw.allowedUserId as number | undefined;
    let userName = (raw.allowedUserName as string) || 'Usuario';

    if (!userId) {
      // Legacy: allowedUsers array
      const users = raw.allowedUsers as Array<{ userId: number; name: string }> | undefined;
      if (users?.length) {
        userId = users[0].userId;
        userName = users[0].name || 'Usuario';
      }
      // Legacy: allowedUserIds array
      const ids = raw.allowedUserIds as number[] | undefined;
      if (!userId && ids?.length) {
        userId = ids[0];
      }
    }

    if (!userId) return null;

    // Persist migration if needed
    if (!raw.allowedUserId || raw.allowedUsers || raw.allowedUserIds) {
      const clean: TelegramConfig = {
        allowedUserId: userId,
        allowedUserName: userName,
        botUsername: raw.botUsername as string | undefined,
        sessionMode: (raw.sessionMode as 'continuous' | 'per-message') || 'continuous',
        notifyOnSchedulerTasks: (raw.notifyOnSchedulerTasks as boolean) ?? false,
      };
      try {
        db.prepare(
          "UPDATE channels SET config = ?, updated_at = datetime('now') WHERE type = 'telegram' AND is_active = 1",
        ).run(JSON.stringify(clean));
        logger.info('Telegram: migrated config to single-user format');
      } catch (e) {
        logger.warn({ error: e }, 'Telegram: failed to persist config migration');
      }
      return clean;
    }

    return {
      allowedUserId: userId,
      allowedUserName: userName,
      botUsername: raw.botUsername as string | undefined,
      sessionMode: (raw.sessionMode as 'continuous' | 'per-message') || 'continuous',
      notifyOnSchedulerTasks: (raw.notifyOnSchedulerTasks as boolean) ?? false,
    };
  } catch {
    return null;
  }
}

export function onTelegramSessionCompacted(oldSessionId: string, newSessionId: string): void {
  if (activeSessionId === oldSessionId) {
    activeSessionId = newSessionId;
  }
}

