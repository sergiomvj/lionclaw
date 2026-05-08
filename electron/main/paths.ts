import path from 'path';
import os from 'os';

/**
 * Diretorio raiz de dados do LionClaw.
 * Sempre em ~/.lionclaw, nunca na pasta do codigo-fonte.
 *
 * Isso e critico: em dev, process.cwd() aponta para a pasta do projeto
 * que contem CLAUDE.md com docs de desenvolvimento. O Agent SDK le
 * CLAUDE.md do cwd automaticamente, poluindo o contexto do agente.
 */
export function getLionClawHome(): string {
  return path.join(os.homedir(), '.lionclaw');
}

/**
 * CWD para o subprocess do Agent SDK (desktop lane).
 *
 * Sempre ~/.lionclaw — onde o CLAUDE.md gerado vive.
 * O SDK lê CLAUDE.md e .claude/ do CWD automaticamente.
 * Usar homedir causava poluição por configs de outros projetos.
 * O agente ainda tem acesso completo ao filesystem via ferramentas.
 */
export function getAgentCwd(_isOnboarding: boolean): string {
  return getLionClawHome();
}

/**
 * CWD isolado para o background lane (Scheduler + Telegram).
 *
 * Usa ~/.lionclaw/background/ com seu proprio CLAUDE.md minimo.
 * Isso garante que o SDK crie um subprocess SEPARADO do desktop,
 * evitando que crons matem a sessao ativa do usuario.
 */
export function getBackgroundCwd(): string {
  return path.join(getLionClawHome(), 'background');
}
