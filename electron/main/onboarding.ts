import { saveUser, saveSoul } from './prompt-builder';
import { createLogger } from './logger';
import { setSetting } from './db';

const logger = createLogger('onboarding');

interface OnboardingData {
  user: {
    nome: string;
    apelido?: string;
    profissao: string;
    areaAtuacao?: string;
    stackPrincipal?: string[];
    projetosAtivos?: string[];
    preferenciasComunicacao?: string;
    horarioTrabalho?: string;
    notasAdicionais?: string;
  };
  agent: {
    nome: string;
    personalidade: string;
    tomDeVoz?: string;
    proatividade?: 'alta' | 'media' | 'baixa';
    limitesCustom?: string[];
  };
}

const ONBOARDING_MARKER_REGEX = /<!-- ONBOARDING_DATA\s*([\s\S]*?)\s*ONBOARDING_DATA -->/;
const ONBOARDING_STRIP_REGEX = /<!-- ONBOARDING_DATA\s*[\s\S]*?\s*ONBOARDING_DATA -->/g;

interface OnboardingCallbacks {
  sendStream: (chunk: { type: string; content?: string }) => void;
  onAudit?: (data: { toolName: string; input: string; output: string }) => void;
}

/**
 * Detecta e processa dados de onboarding na resposta do agente.
 * Retorna o assistantContent limpo (sem marcador) ou null se nao havia onboarding.
 * Emite replace_content e onboarding_completed via sendStream.
 */
export function extractAndProcessOnboardingData(
  assistantContent: string,
  callbacks: OnboardingCallbacks,
): string | null {
  if (!assistantContent.includes('<!-- ONBOARDING_DATA')) return null;

  const match = assistantContent.match(ONBOARDING_MARKER_REGEX);
  if (!match) return null;

  try {
    const onboardingData = JSON.parse(match[1]);
    processOnboardingData(onboardingData);
    setSetting('onboarding_completed', 'true');

    // Limpa marcador do content e envia versao limpa pro renderer
    const cleanedContent = assistantContent.replace(ONBOARDING_STRIP_REGEX, '').trim();
    callbacks.sendStream({ type: 'replace_content', content: cleanedContent });
    callbacks.sendStream({ type: 'onboarding_completed' });

    callbacks.onAudit?.({
      toolName: 'system:onboarding',
      input: JSON.stringify(onboardingData),
      output: 'Onboarding data processed',
    });

    logger.info('Onboarding completed via marker');
    return cleanedContent;
  } catch (e) {
    logger.error({ error: e }, 'Failed to process onboarding data');
    return null;
  }
}

export function processOnboardingData(data: OnboardingData): void {
  const userMd = generateUserMd(data.user);
  saveUser(userMd);
  logger.info('USER.md atualizado via onboarding');

  const soulMd = generateSoulMd(data.agent);
  saveSoul(soulMd);
  logger.info('SOUL.md atualizado via onboarding');
}

function generateUserMd(user: OnboardingData['user']): string {
  const lines: string[] = [];
  lines.push('# Sobre o Usuario');
  lines.push('');
  lines.push('## Dados basicos');
  lines.push(`- Nome: ${user.nome}`);
  if (user.apelido) lines.push(`- Como prefere ser chamado: ${user.apelido}`);
  lines.push(`- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`- OS: ${process.platform}`);
  lines.push('');
  lines.push('## Perfil profissional');
  lines.push(`- ${user.profissao}`);
  if (user.areaAtuacao) lines.push(`- Area: ${user.areaAtuacao}`);
  if (user.stackPrincipal && user.stackPrincipal.length > 0) {
    lines.push(`- Stack: ${user.stackPrincipal.join(', ')}`);
  }
  lines.push('');
  lines.push('## Preferencias de trabalho');
  lines.push(`- Idioma: portugues brasileiro`);
  if (user.preferenciasComunicacao) {
    lines.push(`- Comunicacao: ${user.preferenciasComunicacao}`);
  }
  if (user.horarioTrabalho) {
    lines.push(`- Horario: ${user.horarioTrabalho}`);
  }
  lines.push('');
  if (user.projetosAtivos && user.projetosAtivos.length > 0) {
    lines.push('## Projetos ativos');
    for (const projeto of user.projetosAtivos) {
      lines.push(`- ${projeto}`);
    }
    lines.push('');
  }
  if (user.notasAdicionais) {
    lines.push('## Notas pessoais');
    lines.push(`- ${user.notasAdicionais}`);
    lines.push('');
  }
  return lines.join('\n');
}

function generateSoulMd(agent: OnboardingData['agent']): string {
  const lines: string[] = [];
  lines.push(`# ${agent.nome} - Soul`);
  lines.push('');
  lines.push('## Identidade');
  lines.push(`Voce e ${agent.nome}, um assistente pessoal de IA que roda como app desktop.`);
  lines.push('Voce e leal ao seu usuario, dedicado e eficiente.');
  lines.push('Voce nao e um chatbot generico - voce e O assistente pessoal dedicado do usuario.');
  lines.push('');
  lines.push('## Personalidade');
  lines.push(`${agent.personalidade}`);
  lines.push('');
  lines.push('## Tom de Voz');
  if (agent.tomDeVoz) {
    lines.push(`${agent.tomDeVoz}`);
  } else {
    lines.push('- Portugues brasileiro, informal');
    lines.push('- Como um colega de trabalho senior e confiavel');
    lines.push('- Sem formalidades desnecessarias');
  }
  lines.push('- Nunca use travessoes no meio de frases');
  lines.push('');
  lines.push('## Proatividade');
  const proatividadeMap: Record<string, string> = {
    alta: 'Seja muito proativo: antecipe necessidades, sugira melhorias, avise sobre problemas antes de serem perguntados.',
    media: 'Equilibre proatividade com reatividade: sugira quando relevante mas nao sobrecarregue.',
    baixa: 'Seja majoritariamente reativo: faca o que for pedido, sugira apenas quando essencial.',
  };
  lines.push(proatividadeMap[agent.proatividade || 'media']);
  lines.push('');
  lines.push('## Valores');
  lines.push('- Privacidade do usuario acima de tudo');
  lines.push('- Execucao > explicacao (faca, nao apenas diga como fazer)');
  lines.push('- Transparencia sobre limitacoes');
  lines.push('- Melhoria continua (aprenda com cada interacao)');
  lines.push('');
  lines.push('## Limites');
  lines.push('- Voce opera APENAS no computador do usuario, nunca em servidores remotos sem permissao');
  lines.push('- Voce NUNCA toma decisoes irreversiveis sem confirmacao');
  lines.push('- Voce NUNCA compartilha dados do usuario com terceiros');
  lines.push('- Voce SEMPRE informa quando nao tem certeza sobre algo');
  if (agent.limitesCustom && agent.limitesCustom.length > 0) {
    for (const limite of agent.limitesCustom) {
      lines.push(`- ${limite}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
