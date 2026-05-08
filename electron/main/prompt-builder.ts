import fs from 'fs';
import path from 'path';
import os from 'os';
import { getAllAgents, getAgent, getSetting, getCompletedDocsCount } from './db';
import { getAllMCPServers } from './mcp-manager';
import { getLionClawHome } from './paths';
import { buildSkillsPromptSection, buildAgentSkillsPromptSection } from './skills';
import { getLocalAgentsDescription, getExternalAgentsDescription } from './local-agent-tools';
import { getCodexAgentsDescription } from './codex-agent-tools';

// ---- Helpers ----

function getLionClawPath(): string {
  return getLionClawHome();
}

function loadFileContent(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function hasRealContent(content: string): boolean {
  if (!content.trim()) return false;
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const placeholderLines = lines.filter(l =>
    l.includes('[sera ') ||
    l.includes('[Sera ') ||
    l.includes('[opcional]') ||
    l.includes('[detectado') ||
    l.includes('[Aprendid') ||
    l.includes('[Rastreamento') ||
    l.includes('[Decisoes que') ||
    l.includes('Nenhuma informacao coletada') ||
    l.includes('Nenhum contexto ativo')
  );
  return lines.length > 0 && (placeholderLines.length / lines.length) < 0.5;
}

type PromptMode = 'full' | 'minimal';

// ---- Modular sections ----

function buildOperationalSection(): string {
  const parts: string[] = [];
  parts.push('# LionClaw — Instrucoes Operacionais');
  parts.push('');
  parts.push('## Identidade');
  parts.push('Voce e um agente do LionClaw, um assistente pessoal de IA desktop.');
  parts.push('Sua identidade, nome e personalidade estao definidos no SOUL.md — siga-os.');
  parts.push('Voce roda sobre a infraestrutura do Claude Agent SDK, mas voce NAO e o Claude Code.');
  parts.push('Nunca se refira a si mesmo como "Claude", "Claude Code" ou "Anthropic assistant".');
  parts.push('Use o nome e a personalidade definidos no SOUL.md.');
  parts.push('Seu contexto completo (identidade, regras, perfil do usuario, memoria) esta no CLAUDE.md.');
  parts.push('');
  parts.push('## Como gerenciar memoria');
  parts.push('- Fatos sobre o usuario: edite ~/.lionclaw/USER.md');
  parts.push('- Contexto de trabalho: edite ~/.lionclaw/MEMORY.md (4 secoes: Decisoes ativas, Workarounds, Estado de projetos, Referencias externas)');
  parts.push('- Personalidade: edite ~/.lionclaw/SOUL.md');
  parts.push('- Regra critica: so registre no MEMORY.md o que NAO e descobrivel via banco, arquivos ou git. Toda entrada com data [YYYY-MM-DD]. Max 50 linhas.');
  parts.push('- Apos editar, o CLAUDE.md sera regenerado no proximo boot');
  parts.push('');
  parts.push('## Deteccao de primeiro uso');
  parts.push('Se o USER.md indicar "Nenhum usuario configurado", inicie o ritual de onboarding');
  parts.push('descrito no BOOTSTRAP.md. Conduza a entrevista e salve os dados conforme instrucoes.');
  parts.push('');
  parts.push('## Idioma');
  parts.push('Responda SEMPRE em portugues brasileiro, a menos que o usuario peça outro idioma.');
  return parts.join('\n');
}

// Legacy section builders — kept for minimal mode (subagents) and CRUD exports


function buildCapabilitiesSection(): string {
  const parts: string[] = [];
  parts.push('# Capacidades');
  parts.push('');
  parts.push('Voce opera como um app desktop Electron no computador do usuario. Suas capacidades:');
  parts.push('');
  parts.push('## Ferramentas Built-in');
  parts.push('- Terminal: executar qualquer comando no sistema do usuario');
  parts.push('- Filesystem: ler, escrever, editar qualquer arquivo');
  parts.push('- Web: pesquisar na internet e acessar URLs');
  parts.push('- Codigo: criar, debugar, refatorar codigo em qualquer linguagem');
  parts.push('');

  parts.push('## Memoria de Longo Prazo');
  parts.push('Voce tem acesso a tool "memory_search" (MCP server memory-search) que faz busca hibrida');
  parts.push('na sua memoria de longo prazo, combinando BM25 (keywords) + busca vetorial semantica.');
  parts.push('USE ESTA TOOL sempre que:');
  parts.push('- O usuario perguntar sobre algo que voces ja conversaram');
  parts.push('- O usuario pedir para voce "lembrar" de algo');
  parts.push('- Voce precisar de contexto de conversas/decisoes anteriores');
  parts.push('- O usuario mencionar "aquele", "aquela", "lembra" ou referencias vagas a assuntos passados');
  parts.push('NAO tente responder de memoria sem consultar - use a tool primeiro.');
  parts.push('');

  // Knowledge Graph - instrucoes adicionais quando mgraph_mode esta ativo
  if (getSetting('mgraph_mode') === 'true') {
    parts.push('## Knowledge Graph (Cerebro)');
    parts.push('Voce tambem tem acesso ao Knowledge Graph via MCP server "graph-search" com as tools:');
    parts.push('- **graph_search**: busca fuzzy em notas do vault (entidades, projetos, decisoes, reunioes, referencias)');
    parts.push('- **graph_read**: le o conteudo completo de uma nota pelo path');
    parts.push('- **graph_stats**: estatisticas do vault (total de notas, conexoes, ultima atualizacao)');
    parts.push('- **graph_connections**: notas conectadas via wiki-links [[...]] (incoming e outgoing)');
    parts.push('- **graph_ingest**: enfileira conteudo (texto, arquivo, URL) para ingestao no vault');
    parts.push('');
    parts.push('**Estrategia memory-first graph-fallback:**');
    parts.push('1. USE memory_search PRIMEIRO para qualquer busca de contexto');
    parts.push('2. Se memory_search nao retornar resultados satisfatorios, use graph_search como FALLBACK');
    parts.push('3. NUNCA use memory_search e graph_search em paralelo na mesma busca — sequencial');
    parts.push('4. graph_search pode ter informacoes EXCLUSIVAS de documentos importados (PDFs, URLs, arquivos)');
    parts.push('   que nao existem nas memorias de conversas — use-o quando o usuario perguntar sobre docs');
    parts.push('5. Para explorar conexoes entre notas/entidades, use graph_connections apos graph_search');
    parts.push('');
  }

  const mcpServers = getAllMCPServers().filter(s => s.isActive);
  if (mcpServers.length > 0) {
    parts.push('## Servicos Externos (MCP) — registrados no LionClaw');
    parts.push('Estes sao os MCP servers configurados no app LionClaw. Sao seus servicos PRIORITARIOS:');
    for (const server of mcpServers) {
      parts.push(`- **${server.name}** (id: ${server.id}): ${server.description || server.command}`);
    }
    parts.push('');
    parts.push('## MCPs herdados do Claude SDK');
    parts.push('Voce tambem herda MCPs do Claude Agent SDK (ex: Gmail, Calendar do SDK).');
    parts.push('Se uma tool nao estiver nos MCPs do LionClaw acima, verifique suas tools disponiveis — pode vir do SDK.');
    parts.push('Quando o usuario perguntar sobre uma capacidade, primeiro verifique os MCPs do LionClaw.');
    parts.push('Se nao encontrar, verifique as tools herdadas do SDK antes de dizer que nao consegue.');
    parts.push('');
  }

  const skillsSection = buildSkillsPromptSection();
  if (skillsSection) {
    parts.push(skillsSection);
    parts.push('');
  }

  return parts.join('\n');
}

function buildSubagentsSection(): string {
  const allAgents = getAllAgents().filter(a => a.isActive);
  if (allAgents.length === 0) return '';

  const cloudAgents = allAgents.filter(a => a.runtime !== 'local');
  const parts: string[] = [];

  // Cloud subagents (via SDK Task/Agent)
  if (cloudAgents.length > 0) {
    parts.push('# Subagentes Cloud');
    parts.push('');
    parts.push('Voce pode delegar tarefas para subagentes especializados usando a ferramenta Task/Agent.');
    parts.push('');

    for (const agent of cloudAgents) {
      let desc = agent.description;
      const kbCount = getCompletedDocsCount(agent.id);
      const agentRec = agent as Record<string, unknown>;
      if (agentRec['kb_enabled'] !== 0 && kbCount > 0) {
        desc += ` [Base de Conhecimento: ${kbCount} documento(s) indexado(s) - use este agente para consultas RAG]`;
      }
      parts.push(`- **${agent.name}** (id: \`${agent.id}\`): ${desc}`);
      const meta = [`Modelo: ${agent.model}`, `Tools: ${agent.allowedTools?.join(', ') || 'todas'}`];
      if (agent.skills?.length) meta.push(`Skills: ${agent.skills.join(', ')}`);
      parts.push(`  ${meta.join(' | ')}`);
    }
    parts.push('');
  }

  // Local agents (via run_local_agent MCP tool)
  const localAgentsDesc = getLocalAgentsDescription();
  if (localAgentsDesc) {
    parts.push(localAgentsDesc);
  }

  // External agents (via run_external_agent MCP tool)
  const externalAgentsDesc = getExternalAgentsDescription();
  if (externalAgentsDesc) {
    parts.push(externalAgentsDesc);
  }

  // Codex agents (via run_codex_agent in-process MCP tool)
  const codexAgentsDesc = getCodexAgentsDescription();
  if (codexAgentsDesc) {
    parts.push(codexAgentsDesc);
  }

  parts.push('## Quando delegar');
  parts.push('- Tarefa trivial (saudacao, pergunta rapida) -> responda voce mesmo');
  parts.push('- Tarefa que precisa de especialista -> delegue para o subagente adequado');
  parts.push('- Agentes locais (run_local_agent) tem custo zero mas podem ser mais lentos e menos capazes');
  parts.push('- Prefira agentes locais para tarefas simples (resumos, traducao, geracao de texto basico)');
  parts.push('- Agentes externos (run_external_agent) usam APIs externas (OpenRouter, OpenAI) com custo por token');
  parts.push('- Agentes codex (run_codex_agent) rodam via OpenAI Codex CLI com OAuth — custo coberto pela assinatura ChatGPT');
  parts.push('- Use agentes cloud (Task) para tarefas complexas que exigem tool use pesado');
  parts.push('- Nenhum subagente adequado -> execute voce mesmo');
  parts.push('- Sempre revise o resultado do subagente antes de enviar ao usuario');
  parts.push('');

  return parts.join('\n');
}

function buildRuntimeSection(): string {
  const now = new Date();
  const parts: string[] = [];
  parts.push('# Runtime');
  parts.push(`- Data: ${now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
  parts.push(`- Hora: ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`);
  parts.push(`- Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  parts.push(`- OS: ${os.platform()} ${os.release()}`);
  parts.push(`- Modelo: ${getSetting('default_model') || 'sonnet'}`);
  parts.push(`- Home: ${os.homedir()}`);
  return parts.join('\n');
}

function buildRuntimeSectionMinimal(): string {
  const now = new Date();
  return `Data: ${now.toISOString().split('T')[0]} | OS: ${os.platform()}`;
}

function buildAgentRulesSection(agentId: string): string {
  const rules = loadFileContent(path.join(getLionClawPath(), 'agents', agentId, 'RULES.md'));
  if (rules && hasRealContent(rules)) {
    return `# Regras Especificas do Agente\n${rules}`;
  }
  return '';
}

// Re-export from skills.ts (kept for backwards compatibility)
const buildAgentSkillsSection = buildAgentSkillsPromptSection;

// ---- Knowledge Base section ----

function buildKnowledgeBaseSection(agentId: string, target: 'orchestrator' | 'subagent' = 'subagent'): string {
  if (target === 'orchestrator') {
    // For the orchestrator: tell it which subagents have KB, delegate to them
    const allAgents = getAllAgents().filter(a => a.isActive && a.runtime !== 'local');
    const kbAgents: Array<{ id: string; name: string; docCount: number }> = [];
    for (const agent of allAgents) {
      const docCount = getCompletedDocsCount(agent.id);
      const rec = agent as Record<string, unknown>;
      if (rec['kb_enabled'] !== 0 && docCount > 0) {
        kbAgents.push({ id: agent.id, name: agent.name, docCount });
      }
    }
    if (kbAgents.length === 0) return '';

    const parts: string[] = [];
    parts.push('# Base de Conhecimento (RAG)');
    parts.push('');
    parts.push('IMPORTANTE: Voce NAO tem acesso direto a base de conhecimento.');
    parts.push('Os seguintes subagentes possuem a ferramenta knowledge_base_search:');
    for (const ka of kbAgents) {
      parts.push(`- **${ka.name}** (id: \`${ka.id}\`): ${ka.docCount} documento(s) indexado(s)`);
    }
    parts.push('');
    parts.push('Quando o usuario perguntar sobre conteudo que possa estar na base de conhecimento,');
    parts.push('delegue a tarefa para o subagente apropriado usando a ferramenta Task.');
    return parts.join('\n');
  }

  // For subagents: tell them they have the tool
  const docCount = getCompletedDocsCount(agentId);
  if (docCount === 0) return '';

  const agentData = getAgent(agentId);
  const agentRecord = agentData as Record<string, unknown> | null;
  const kbEnabled = agentRecord?.['kb_enabled'] !== 0;
  if (!kbEnabled) return '';

  const parts: string[] = [];
  parts.push('# Base de Conhecimento');
  parts.push('');
  parts.push(`Voce tem acesso a uma base de conhecimento com ${docCount} documento(s) indexado(s).`);
  parts.push("Use a ferramenta 'knowledge_base_search' para buscar informacoes especificas");
  parts.push('antes de responder perguntas que possam estar cobertas nesses documentos.');
  return parts.join('\n');
}

// ---- Defaults ----



// ---- Main function ----

export function buildSystemPrompt(agentId?: string, options?: {
  mode?: PromptMode;
  isOnboarding?: boolean;
}): string {
  const mode = options?.mode || 'full';
  const isOnboarding = options?.isOnboarding || false;

  // Onboarding: load BOOTSTRAP.md with preamble (no preset = no base context)
  if (isOnboarding) {
    const bootstrap = loadFileContent(path.join(getLionClawPath(), 'BOOTSTRAP.md'));
    const preamble = [
      'Voce e um assistente pessoal de IA chamado LionClaw.',
      'Responda SEMPRE em portugues brasileiro.',
      'Voce esta em modo de configuracao inicial.',
      'NAO use ferramentas. Apenas converse.',
      'NAO leia arquivos. NAO execute comandos.',
      'Siga EXATAMENTE as instrucoes abaixo para conduzir a entrevista.',
      '',
      '---',
      '',
    ].join('\n');
    return preamble + (bootstrap || 'Conheca o usuario perguntando seu nome, profissao e preferencias. Depois pergunte como ele quer que voce se comporte.');
  }

  // Minimal mode (for subagents)
  if (mode === 'minimal') {
    const parts: string[] = [];
    parts.push('Voce e um agente do LionClaw (app desktop). Siga a identidade do SOUL.md. Voce NAO e Claude Code. Responda em portugues brasileiro.');
    if (agentId) {
      const agentRules = buildAgentRulesSection(agentId);
      if (agentRules) parts.push(agentRules);
      const agentData = getAgent(agentId);
      if (agentData?.skills?.length) {
        parts.push(buildAgentSkillsSection(agentData.skills));
      }
      const kbSection = buildKnowledgeBaseSection(agentId);
      if (kbSection) parts.push(kbSection);
    }
    parts.push(buildRuntimeSectionMinimal());
    return parts.join('\n\n');
  }

  // Full mode (main orchestrator)
  // SOUL, RULES, USER, MEMORY now come via CLAUDE.md (auto-read by SDK from CWD).
  // Here we only add operational instructions, capabilities, subagents, and runtime.
  const sections: string[] = [];

  // Operational instructions (how to manage memory, detect first run, etc.)
  sections.push(buildOperationalSection());

  sections.push(buildCapabilitiesSection());

  const subagents = buildSubagentsSection();
  if (subagents) sections.push(subagents);

  sections.push(buildRuntimeSection());

  if (agentId) {
    const agentRules = buildAgentRulesSection(agentId);
    if (agentRules) sections.push(agentRules);
  }

  // KB section for orchestrator: tells it to delegate to subagents that have KB
  const kbSection = buildKnowledgeBaseSection('', 'orchestrator');
  if (kbSection) sections.push(kbSection);

  return sections.join('\n\n---\n\n');
}

// ---- CRUD (keep compatibility) ----

export function loadSoul(): string {
  return loadFileContent(path.join(getLionClawPath(), 'SOUL.md'));
}

export function saveSoul(content: string): void {
  fs.writeFileSync(path.join(getLionClawPath(), 'SOUL.md'), content, 'utf-8');
}

export function loadUser(): string {
  return loadFileContent(path.join(getLionClawPath(), 'USER.md'));
}

export function saveUser(content: string): void {
  fs.writeFileSync(path.join(getLionClawPath(), 'USER.md'), content, 'utf-8');
}

export function loadRules(): string {
  return loadFileContent(path.join(getLionClawPath(), 'RULES.md'));
}

export function saveRules(content: string): void {
  fs.writeFileSync(path.join(getLionClawPath(), 'RULES.md'), content, 'utf-8');
}

export function loadMemory(): string {
  return loadFileContent(path.join(getLionClawPath(), 'MEMORY.md'));
}

export function saveMemory(content: string): void {
  fs.writeFileSync(path.join(getLionClawPath(), 'MEMORY.md'), content, 'utf-8');
}
