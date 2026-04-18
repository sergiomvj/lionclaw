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
 * CWD para o subprocess do Agent SDK.
 *
 * Sempre ~/.lionclaw — onde o CLAUDE.md gerado vive.
 * O SDK lê CLAUDE.md e .claude/ do CWD automaticamente.
 * Usar homedir causava poluição por configs de outros projetos.
 * O agente ainda tem acesso completo ao filesystem via ferramentas.
 */
export function getAgentCwd(_isOnboarding: boolean): string {
  return getLionClawHome();
}
