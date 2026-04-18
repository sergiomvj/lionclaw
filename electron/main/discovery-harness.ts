/**
 * Discovery Harness - Controle programatico do fluxo de discovery.
 *
 * Tira o controle de escrita do agente e coloca no harness (codigo).
 * O agente APENAS conversa. O harness controla:
 * - Qual pergunta estamos (state machine Q1-Q11)
 * - O que escrever no discovery-notes.md (fs.writeFileSync, sem LLM)
 * - Quando avancar de pergunta (apos extrair resposta)
 * - Quando mudar de etapa (apos Q11 + confirmacao)
 */

import { BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { getApiKey } from './secrets-vault';
import { updateWorkflowQuestion } from './db';
import type { WorkflowRun } from '../../src/types';

const logger = createLogger('discovery-harness');

export function resetDiscoverySessionState(): void {
  // Noop: discovery harness agora usa Anthropic SDK direto, sem estado de sessao
}

// ---- Question definitions ----

interface QuestionDef {
  id: string;
  text: string;
  notesSection: string;
  notesField: string;
  next: string | null;
  conditional?: boolean;
}

const QUESTIONS: Record<string, QuestionDef> = {
  Q1: {
    id: 'Q1',
    text: 'Qual problema esse produto resolve? Me explica como se tivesse contando pra um amigo.',
    notesSection: '## Visao',
    notesField: '**Problema**',
    next: 'Q2',
  },
  Q2: {
    id: 'Q2',
    text: 'Quem eh o usuario principal? Me descreve essa pessoa, o dia a dia dela, o que ela faz.',
    notesSection: '## Visao',
    notesField: '**Usuario principal**',
    next: 'Q3',
  },
  Q3: {
    id: 'Q3',
    text: 'Tem algum produto parecido como referencia? Tipo "quero algo como X mas com Y diferente".',
    notesSection: '## Visao',
    notesField: '**Referencia**',
    next: 'PITCH_VALIDATION',
  },
  PITCH_VALIDATION: {
    id: 'PITCH_VALIDATION',
    text: '[HARNESS: agente sintetiza pitch das 3 respostas e pede validacao]',
    notesSection: '## Visao',
    notesField: '**Pitch**',
    next: 'Q4',
  },
  Q4: {
    id: 'Q4',
    text: 'Me lista as 3 coisas PRINCIPAIS que o usuario precisa fazer no produto. So as 3 mais importantes.',
    notesSection: '## Funcionalidades',
    notesField: '**Core features**',
    next: 'Q5',
  },
  Q5: {
    id: 'Q5',
    text: 'O produto precisa se conectar com algum sistema externo, API, ou servico que voce ja usa?',
    notesSection: '## Funcionalidades',
    notesField: '**Integracoes**',
    next: 'Q6',
  },
  Q6: {
    id: 'Q6',
    text: 'Como pretende monetizar? Assinatura mensal, creditos por uso, freemium, venda unica?',
    notesSection: '## Monetizacao',
    notesField: '**Modelo**',
    next: 'Q7_CHECK',
  },
  Q7: {
    id: 'Q7',
    text: 'Quantos planos e o que diferencia cada um?',
    notesSection: '## Monetizacao',
    notesField: '**Planos**',
    next: 'Q8',
    conditional: true,
  },
  Q8: {
    id: 'Q8',
    text: 'Tem alguma tecnologia que voce ja usa ou tem preferencia? Linguagem, framework, banco de dados?',
    notesSection: '## Tecnico',
    notesField: '**Stack**',
    next: 'Q9',
  },
  Q9: {
    id: 'Q9',
    text: 'O produto precisa funcionar no celular? Se sim, como app nativo ou pelo navegador ta ok?',
    notesSection: '## Tecnico',
    notesField: '**Plataforma**',
    next: 'Q10',
  },
  Q10: {
    id: 'Q10',
    text: 'Tem wireframe, imagem, fluxo ou referencia visual pra compartilhar?',
    notesSection: '## Contexto',
    notesField: '**Referencias visuais**',
    next: 'Q11',
  },
  Q11: {
    id: 'Q11',
    text: 'Algo mais que eu deveria saber sobre o produto ou o contexto?',
    notesSection: '## Contexto',
    notesField: '**Notas adicionais**',
    next: 'SUMMARY_VALIDATION',
  },
  SUMMARY_VALIDATION: {
    id: 'SUMMARY_VALIDATION',
    text: '[HARNESS: agente apresenta resumo completo e pede confirmacao]',
    notesSection: '',
    notesField: '',
    next: null,
  },
};

// ---- Helpers ----

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getQuestionNumber(qId: string): number {
  const map: Record<string, number> = {
    Q1: 1, Q2: 2, Q3: 3, PITCH_VALIDATION: 3,
    Q4: 4, Q5: 5, Q6: 6, Q7: 7, Q8: 8,
    Q9: 9, Q10: 10, Q11: 11, SUMMARY_VALIDATION: 11,
  };
  return map[qId] ?? 1;
}

function getWorkflowBaseDir(): string {
  return path.join(getLionClawHome(), 'workflows', 'build-plan');
}

function getNotesPath(workflowRun: WorkflowRun): string {
  if (workflowRun.notesPath) return workflowRun.notesPath;
  return path.join(getWorkflowBaseDir(), 'discovery-notes.md');
}

function emitIPC(getWindow: () => BrowserWindow | null, channel: string, data: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, data);
  }
}

// ---- Conversation context for extraction ----

let recentMessages: Array<{ role: string; content: string }> = [];

function buildConversationContext(): string {
  return recentMessages.slice(-4).map(m => `${m.role}: ${m.content}`).join('\n');
}

// ---- System Prompt Builder ----

function buildConversationalPrompt(
  _workflowRun: WorkflowRun,
  currentQ: string,
  _notesContent: string,
  collectedAnswers: Record<string, string>,
): string {
  const qDef = QUESTIONS[currentQ];

  let prompt = `Voce eh um assistente de planejamento de produto. Voce esta conduzindo um discovery com o usuario.

## Seu papel
- Voce CONVERSA com o usuario. Voce NAO tem ferramentas. Voce NAO escreve documentos.
- Seja natural, de opinioes, faca follow-ups inteligentes, sugira quando o usuario nao souber.
- Responda SEMPRE em portugues brasileiro.
- NUNCA gere listas estruturadas, documentos, specs ou markdown formatado. Voce esta conversando.

## Contexto coletado ate agora
`;

  for (const [qId, answer] of Object.entries(collectedAnswers)) {
    const q = QUESTIONS[qId];
    if (q) {
      prompt += `- ${q.notesField}: ${answer}\n`;
    }
  }

  if (currentQ === 'PITCH_VALIDATION') {
    prompt += `
## Sua tarefa agora
Sintetize um pitch do produto em 2-3 frases baseado nas respostas Q1, Q2 e Q3.
Apresente pro usuario e pergunte: "Isso representa bem a visao? Posso continuar?"
Se o usuario disser que nao, pergunte o que ajustar. Quando ele confirmar, responda normalmente.
NAO faca a proxima pergunta ainda. Apenas valide o pitch.`;

  } else if (currentQ === 'SUMMARY_VALIDATION') {
    prompt += `
## Sua tarefa agora
Apresente um RESUMO COMPLETO de tudo que foi coletado, organizado por blocos:
- Visao (problema, usuario, referencia, pitch)
- Funcionalidades (core features, integracoes)
- Monetizacao (modelo, planos)
- Tecnico (stack, plataforma)
- Contexto (referencias visuais, notas adicionais)

Pergunte: "Esse resumo do discovery esta completo e correto? Se quiser ajustar algo, eh so me falar."
NAO use markdown pesado. Fale naturalmente, como se tivesse resumindo numa reuniao.`;

  } else if (qDef) {
    prompt += `
## Sua tarefa agora
Faca a seguinte pergunta ao usuario (pode adaptar o tom, mas o conteudo deve ser esse):
"${qDef.text}"

${currentQ === 'Q1' ? 'Esta eh a primeira pergunta. De boas vindas e comece o discovery.' : ''}
${currentQ === 'Q5' ? 'Dica: contextualize com as features que o usuario ja mencionou.' : ''}
${currentQ === 'Q8' ? 'Se o usuario nao souber, diga que o agente de geracao vai sugerir baseado no contexto.' : ''}

IMPORTANTE:
- Faca APENAS esta pergunta. NAO faca perguntas adicionais.
- Nao antecipe perguntas futuras.
- Voce pode comentar a resposta anterior do usuario antes de fazer a nova pergunta.`;
  }

  return prompt;
}

// ---- Answer Extractor (one-shot haiku) ----

async function extractAnswer(
  userMessage: string,
  questionId: string,
  conversationContext: string,
): Promise<{ answer: string; isSaaS?: boolean; pitchApproved?: boolean }> {
  const qDef = QUESTIONS[questionId];

  const extractionPrompt = `Extraia a resposta do usuario para a pergunta do discovery.

Pergunta: ${qDef?.text ?? questionId}
Mensagem do usuario: "${userMessage}"
Contexto da conversa: ${conversationContext}

Responda em JSON puro (sem markdown, sem code block):
{
  "answer": "resposta extraida como fato decidido, sem 'talvez' ou 'sugerido'"${questionId === 'Q6' ? ',\n  "isSaaS": true' : ''}${questionId === 'PITCH_VALIDATION' ? ',\n  "pitchApproved": true' : ''}
}

${questionId === 'Q6' ? 'isSaaS: true se modelo eh assinatura/SaaS/recorrente, false caso contrario.' : ''}
${questionId === 'PITCH_VALIDATION' ? 'pitchApproved: true se usuario aprovou o pitch (disse "sim", "ok", "correto", "pode continuar", etc.), false se rejeitou ou pediu ajustes.' : ''}

Se o usuario nao respondeu claramente, use "answer": "[pendente - usuario nao definiu]".`;

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const apiKey = await getApiKey();
    if (!apiKey) {
      logger.warn({ questionId }, 'No API key available for extractor, using raw message');
      return makeFallback(userMessage, questionId);
    }

    const client = new Anthropic({ apiKey });

    // Timeout de 30s pra nunca travar o app
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await client.messages.create(
        {
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: extractionPrompt }],
        },
        { signal: controller.signal },
      );

      clearTimeout(timeout);

      const fullText = response.content[0]?.type === 'text'
        ? response.content[0].text
        : '';

      if (!fullText.trim()) {
        logger.warn({ questionId }, 'Extractor returned empty text, using raw message');
        return makeFallback(userMessage, questionId);
      }

      // Limpar possivel markdown wrapping
      const cleaned = fullText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
      return JSON.parse(cleaned);
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    logger.warn({ questionId, err }, 'Failed to extract answer, using fallback');
    return makeFallback(userMessage, questionId);
  }
}

/** Fallback com heuristicas regex quando a API falha */
function makeFallback(
  userMessage: string,
  questionId: string,
): { answer: string; isSaaS?: boolean; pitchApproved?: boolean } {
  const fallback: { answer: string; isSaaS?: boolean; pitchApproved?: boolean } = {
    answer: userMessage.trim(),
  };
  if (questionId === 'PITCH_VALIDATION') {
    const lower = userMessage.toLowerCase();
    fallback.pitchApproved = /\b(sim|ok|correto|pode|isso|perfeito|bom|continua|exato|certo)\b/.test(lower);
  }
  if (questionId === 'Q6') {
    const lower = userMessage.toLowerCase();
    fallback.isSaaS = /\b(assinatura|saas|mensal|recorrente|subscription|plano)\b/.test(lower);
  }
  return fallback;
}

// ---- Notes Writer (pure code, no LLM) ----

function writeAnswerToNotes(
  notesPath: string,
  section: string,
  field: string,
  answer: string,
): void {
  let content = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';

  const fieldPattern = new RegExp(
    `(- ${escapeRegex(field)}:)(.*)`,
    'm',
  );

  if (fieldPattern.test(content)) {
    content = content.replace(fieldPattern, `$1 ${answer}`);
  } else {
    // Field does not exist yet, add to the correct section
    const sectionIndex = content.indexOf(section);
    if (sectionIndex !== -1) {
      const nextSection = content.indexOf('\n## ', sectionIndex + section.length);
      const insertAt = nextSection !== -1 ? nextSection : content.length;
      const insertion = `- ${field}: ${answer}\n`;
      content = content.slice(0, insertAt) + insertion + content.slice(insertAt);
    } else {
      // Section doesn't exist either, append both
      content += `\n${section}\n\n- ${field}: ${answer}\n`;
    }
  }

  fs.writeFileSync(notesPath, content, 'utf-8');
}

// ---- Parse collected answers from notes ----

function parseCollectedAnswers(notesContent: string): Record<string, string> {
  const answers: Record<string, string> = {};

  for (const [qId, qDef] of Object.entries(QUESTIONS)) {
    if (!qDef.notesField) continue;

    const fieldPattern = new RegExp(
      `- ${escapeRegex(qDef.notesField)}:\\s*(.+)`,
      'm',
    );
    const match = notesContent.match(fieldPattern);
    if (match && match[1].trim() && !match[1].trim().startsWith('[')) {
      answers[qId] = match[1].trim();
    }
  }

  return answers;
}

// ---- Main handler ----

export async function handleDiscoveryMessage(
  message: string,
  workflowRun: WorkflowRun,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const currentQ = workflowRun.currentQuestion ?? 'Q1';
  const qDef = QUESTIONS[currentQ];
  const notesPath = getNotesPath(workflowRun);

  // Ensure workflow directory exists
  const workflowDir = getWorkflowBaseDir();
  fs.mkdirSync(workflowDir, { recursive: true });

  const notesContent = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';
  const collectedAnswers = parseCollectedAnswers(notesContent);

  // Check if this is the initial auto-trigger
  const isInitialTrigger = currentQ === 'Q1' && message === 'Comece o discovery. Faca a primeira pergunta.';

  // Track conversation for context
  if (!isInitialTrigger) {
    recentMessages.push({ role: 'user', content: message });
    if (recentMessages.length > 6) recentMessages.shift();
  }

  logger.info(
    { workflowRunId: workflowRun.id, currentQ, isInitialTrigger },
    'handleDiscoveryMessage: starting',
  );

  // If NOT initial trigger, extract answer from user message
  if (!isInitialTrigger && qDef && qDef.notesField) {
    const extraction = await extractAnswer(message, currentQ, buildConversationContext());

    // Write to notes if we got a valid answer
    if (extraction.answer && extraction.answer !== '[pendente - usuario nao definiu]') {
      writeAnswerToNotes(notesPath, qDef.notesSection, qDef.notesField, extraction.answer);

      // Emit notes updated
      const updatedNotes = fs.readFileSync(notesPath, 'utf-8');
      emitIPC(getWindow, 'workflow:notes-updated', {
        content: updatedNotes,
        path: notesPath,
      });
    }

    // Determine next state
    let nextQ: string | null = qDef.next;

    // Q6 -> Q7_CHECK: decide if we skip Q7
    if (nextQ === 'Q7_CHECK') {
      nextQ = extraction.isSaaS ? 'Q7' : 'Q8';
    }

    // PITCH_VALIDATION: only advance if user approved
    if (currentQ === 'PITCH_VALIDATION' && !extraction.pitchApproved) {
      nextQ = 'PITCH_VALIDATION'; // Stay in same state
    }

    // SUMMARY_VALIDATION: don't advance automatically (UI buttons control)
    if (currentQ === 'SUMMARY_VALIDATION') {
      nextQ = 'SUMMARY_VALIDATION'; // Stay until [Approve] clicked
    }

    // Advance state in DB
    if (nextQ && nextQ !== currentQ) {
      updateWorkflowQuestion(workflowRun.id, nextQ);
      workflowRun.currentQuestion = nextQ;

      // Emit question change to frontend
      emitIPC(getWindow, 'workflow:question-changed', {
        question: nextQ,
        total: 11,
        current: getQuestionNumber(nextQ),
      });
    }
  }

  // Build system prompt for agent conversation
  const nextQ = workflowRun.currentQuestion ?? currentQ;
  const updatedNotes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf-8') : '';
  const updatedAnswers = parseCollectedAnswers(updatedNotes);

  const systemPrompt = buildConversationalPrompt(workflowRun, nextQ, updatedNotes, updatedAnswers);

  // Query agent via Anthropic SDK (no subprocess, no hang risk)
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const apiKey = await getApiKey();
  if (!apiKey) {
    emitIPC(getWindow, 'workflow:stream', { type: 'error', error: 'API key nao configurada' });
    emitIPC(getWindow, 'workflow:stream', { type: 'done' });
    return;
  }

  const client = new Anthropic({ apiKey });
  const userPrompt = isInitialTrigger
    ? 'Comece o discovery. De boas vindas e faca a primeira pergunta.'
    : message;

  // Montar mensagens com historico recente pra manter contexto conversacional
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    ...recentMessages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: userPrompt },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  let agentResponse = '';

  try {
    const stream = client.messages.stream(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages: chatMessages,
      },
      { signal: controller.signal },
    );

    stream.on('text', (text) => {
      agentResponse += text;
      emitIPC(getWindow, 'workflow:stream', { type: 'text', content: text });
    });

    await stream.finalMessage();
  } finally {
    clearTimeout(timeout);
  }

  emitIPC(getWindow, 'workflow:stream', { type: 'done' });

  // Track agent response for context
  if (agentResponse) {
    recentMessages.push({ role: 'assistant', content: agentResponse });
    if (recentMessages.length > 6) recentMessages.shift();
  }

  // If we reached SUMMARY_VALIDATION, signal frontend to show buttons
  if ((workflowRun.currentQuestion ?? currentQ) === 'SUMMARY_VALIDATION') {
    emitIPC(getWindow, 'workflow:discovery-complete', {
      notesPath,
      notesContent: fs.readFileSync(notesPath, 'utf-8'),
    });
  }
}
