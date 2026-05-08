/**
 * pipeline-shared/ipc-emitter.ts
 *
 * Helper unico pra emitir eventos IPC pra TODAS as windows (broadcast).
 * Antes desta extracao (S2.3), varios modulos faziam BrowserWindow.getAllWindows()
 * direto, com pequenas variacoes (alguns enviavam para win[0], outros iteravam).
 * Esse helper consolida o pattern: broadcast pra todas as windows abertas.
 *
 * Uso:
 *   import { emitIPC } from './pipeline-shared/ipc-emitter';
 *   emitIPC('pipeline:phase-changed', { projectId, phase });
 *
 * Notas:
 * - Broadcast pra todas as windows (compat com pattern atual; o renderer
 *   filtra por canal/payload).
 * - Idempotente: se nao houver windows ou se a window ja foi destruida, no-op.
 * - Erros (render frame disposto, GPU crash, reload) sao engolidos
 *   silenciosamente para nao derrubar o main process.
 */

import { BrowserWindow } from 'electron';

export function emitIPC(channel: string, payload: unknown): void {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const win of wins) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  } catch {
    // renderer not available (window destroyed / reloaded / GPU crash)
  }
}
