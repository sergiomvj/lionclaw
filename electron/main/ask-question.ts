import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import { createLogger } from './logger';
import type { AskQuestionRequest, AskQuestionResponse } from '../../src/types';

const logger = createLogger('ask-question');

interface PendingAskQuestion {
  resolve: (response: AskQuestionResponse) => void;
  timeout: NodeJS.Timeout;
}

const pendingAskQuestions = new Map<string, PendingAskQuestion>();

export function sendAskQuestion(
  getWindow: () => BrowserWindow | null,
  questions: AskQuestionRequest['questions'],
): Promise<AskQuestionResponse> {
  const window = getWindow();
  if (!window) {
    return Promise.reject(new Error('Janela nao disponivel para pergunta'));
  }

  const id = crypto.randomUUID();
  const request: AskQuestionRequest = { id, questions };

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAskQuestions.delete(id);
      logger.warn({ id }, 'AskUserQuestion timeout (5 min)');
      reject(new Error('AskUserQuestion timeout (5 min)'));
    }, 300_000);

    pendingAskQuestions.set(id, { resolve, timeout });

    window.webContents.send('chat:ask-question', request);

    // Also send as stream chunk so chat history shows the question
    window.webContents.send('chat:stream', {
      type: 'ask_question',
      askRequest: request,
    });
  });
}

export function resolveAskQuestion(response: AskQuestionResponse): void {
  const pending = pendingAskQuestions.get(response.id);
  if (!pending) {
    logger.warn({ id: response.id }, 'AskQuestion response not found');
    return;
  }

  clearTimeout(pending.timeout);
  pendingAskQuestions.delete(response.id);
  pending.resolve(response);
  logger.info({ id: response.id }, 'AskQuestion resolved');
}
