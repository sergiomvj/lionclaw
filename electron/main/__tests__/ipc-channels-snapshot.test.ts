import { describe, expect, it } from 'vitest';

/**
 * Golden snapshots dos canais IPC do pipeline.
 *
 * Esses snapshots capturam a FORMA dos payloads emitidos por cada canal IPC
 * relevante (chat, harness, enrich, pipeline, security audit). Antes de
 * refatorar stream/persist (Sprints S2.1, S2.2 e S2.3 da SPEC
 * `SPEC-refactor-pipelines.md`), eles servem como CONTRATO:
 * se algum refator alterar inadvertidamente a forma de um payload, o
 * snapshot falha imediatamente.
 *
 * R2 (SPEC linha 31): "UI e streaming nao podem quebrar". Esses snapshots
 * sao o trip-wire dessa regra.
 *
 * Os payloads abaixo NAO sao gerados por execucao real. Sao reproducoes
 * fieis dos shapes emitidos pelos callsites originais (extraidos por
 * leitura direta do codigo fonte em 2026-05-03):
 *
 *   - chat:stream           ........ orchestrator.ts (sendStream + sessionId)
 *                                    ask-question.ts (ask_question chunk)
 *   - harness:agent-stream  ........ harness-engine.ts
 *                                    OBS: ha DOIS shapes em uso — capturamos
 *                                    ambos para guiar a unificacao em S2.1.
 *   - enrich:stream         ........ harness-engine.ts (runEnrichExecuteAgent)
 *   - enrich:metrics        ........ harness-engine.ts
 *   - enrich:status         ........ harness-engine.ts
 *   - pipeline:stream       ........ pipeline-engine.ts (spawnAgent)
 *                                    security-audit-runner.ts (audit variant
 *                                    inclui auditAgentId/auditAgentSlug).
 *   - pipeline:phase-changed ....... pipeline-engine.ts
 *   - pipeline:project-updated ..... pipeline-engine.ts (updateProjectColumns)
 *   - pipeline:security-agent-status security-audit-runner.ts
 *   - pipeline:audit-agent-progress  security-audit-runner.ts
 *
 * Como regenerar (intencionalmente, depois de uma mudanca aprovada):
 *
 *     npx vitest run electron/main/__tests__/ipc-channels-snapshot.test.ts \
 *       --update-snapshots
 *
 * Os goldens ficam em
 * `electron/main/__tests__/__snapshots__/ipc-channels-snapshot.test.ts.snap`
 * e devem ser revisados a mao no diff antes de commit.
 */

describe('IPC channel payload snapshots', () => {
  // -------------------------------------------------------------------------
  // chat:stream — emitido pelo orchestrator. Todos os chunks sao do tipo
  // StreamChunk (src/types/index.ts) e geralmente carregam sessionId injetado
  // pelo sendSessionStream wrapper.
  // -------------------------------------------------------------------------

  describe('chat:stream', () => {
    it('text chunk with sessionId', () => {
      const payload = {
        type: 'text',
        content: 'Olá, como posso ajudar?',
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        type: 'tool_call',
        tool: 'Read',
        input: { file_path: '/Users/example/file.ts' },
        sessionId: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk with queueRemaining', () => {
      // queueRemaining é injetado em sendStream quando a fila tem >0
      const payload = {
        type: 'done',
        sessionId: 'sess_abc123',
        queueRemaining: 2,
      };
      expect(payload).toMatchSnapshot();
    });

    it('session chunk (sessionId broadcast)', () => {
      const payload = {
        type: 'session',
        content: 'sess_abc123',
      };
      expect(payload).toMatchSnapshot();
    });

    it('ask_question chunk (from ask-question.ts)', () => {
      const payload = {
        type: 'ask_question',
        askRequest: {
          id: 'ask_xyz789',
          questions: [
            {
              question: 'Qual ambiente?',
              header: 'Selecione',
              options: [
                { label: 'dev', description: 'Desenvolvimento' },
                { label: 'prod', description: 'Producao' },
              ],
            },
          ],
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('error chunk', () => {
      const payload = {
        type: 'error',
        error: 'API key nao configurada. Va em Settings.',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // harness:agent-stream — emitido pelo HarnessEngine.
  //
  // ATENCAO: ha DOIS shapes em uso (verificado em harness-engine.ts):
  //   A) NESTED: { projectId, [sprintId, round,] agent, event: { type, ... } }
  //      usado em: planner (cloud/external), coder, evaluator
  //   B) FLAT:   { projectId, agent, type, content }
  //      usado em: planner (local) — harness-engine.ts:960, 1005, 1008, 1011
  //
  // S2.1 deve unificar. Capturamos ambos para travar o "antes".
  // -------------------------------------------------------------------------

  describe('harness:agent-stream', () => {
    it('NESTED shape — planner text event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'text', content: 'Vou começar planejando...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — planner thinking event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'thinking', content: 'Considerando arquitetura...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — planner tool_use event', () => {
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        event: { type: 'tool_use', tool: 'Glob' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder text event with sprintId/round', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'text', content: 'Implementando feature...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder tool_call event', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'tool_call', tool: 'Edit' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — coder text_delta (external API streaming)', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'coder',
        event: { type: 'text_delta', content: 'partial chunk' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('NESTED shape — evaluator text event', () => {
      const payload = {
        projectId: 'proj_123',
        sprintId: 'sprint_1',
        round: 2,
        agent: 'evaluator',
        event: { type: 'text', content: 'Avaliando criterios...' },
      };
      expect(payload).toMatchSnapshot();
    });

    it('FLAT shape — planner local runtime (no event wrapper)', () => {
      // Inconsistencia historica: o caminho local emite shape diferente.
      // S2.1 deve unificar para o NESTED.
      const payload = {
        projectId: 'proj_123',
        agent: 'planner',
        type: 'text',
        content: 'Planner local rodando...',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // enrich:stream — emitido por harness-engine.runEnrichExecuteAgent.
  // Shape: { type, sessionId, phase, content?, tool? }
  // -------------------------------------------------------------------------

  describe('enrich:stream', () => {
    it('text chunk', () => {
      const payload = {
        type: 'text',
        content: 'Validando SPEC...',
        sessionId: 'enrich_sess_42',
        phase: 'validator',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        type: 'tool_call',
        tool: 'Read',
        sessionId: 'enrich_sess_42',
        phase: 'validator',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk with output content', () => {
      const payload = {
        type: 'done',
        content: 'Análise concluída. 3 gaps encontrados.',
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk without content', () => {
      const payload = {
        type: 'done',
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // enrich:metrics — emitido apos cada turno completar.
  // -------------------------------------------------------------------------

  describe('enrich:metrics', () => {
    it('validator metrics', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        metrics: {
          inputTokens: 12_345,
          outputTokens: 678,
          cacheReadTokens: 9_876,
          cacheCreationTokens: 200,
          costUsd: 0.0432,
          durationMs: 8_400,
          toolUses: 3,
          apiRequests: 1,
          messages: 1,
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('enricher metrics', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
        metrics: {
          inputTokens: 5_000,
          outputTokens: 1_200,
          cacheReadTokens: 2_000,
          cacheCreationTokens: 0,
          costUsd: 0.0123,
          durationMs: 4_100,
          toolUses: 2,
          apiRequests: 1,
          messages: 1,
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // enrich:status — transicoes de estado da sessao.
  // status: 'idle' | 'running' | 'waiting'
  // phase: 'validator' | 'enricher'
  // -------------------------------------------------------------------------

  describe('enrich:status', () => {
    it('validator running', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        status: 'running',
      };
      expect(payload).toMatchSnapshot();
    });

    it('validator waiting', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'validator',
        status: 'waiting',
      };
      expect(payload).toMatchSnapshot();
    });

    it('enricher idle (terminal)', () => {
      const payload = {
        sessionId: 'enrich_sess_42',
        phase: 'enricher',
        status: 'idle',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // pipeline:stream — emitido por PipelineEngine.spawnAgent (pipeline-engine.ts)
  // e tambem por SecurityAuditRunner (security-audit-runner.ts), com extras.
  // -------------------------------------------------------------------------

  describe('pipeline:stream', () => {
    it('text chunk (regular phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 2,
        type: 'text',
        content: 'Gerando stories...',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 4,
        type: 'tool_call',
        tool: 'Write',
      };
      expect(payload).toMatchSnapshot();
    });

    it('done chunk', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 4,
        type: 'done',
      };
      expect(payload).toMatchSnapshot();
    });

    it('text chunk from security audit (with auditAgentId/auditAgentSlug)', () => {
      const payload = {
        type: 'text',
        projectId: 'proj_456',
        phase: 11,
        content: 'Analisando vulnerabilidades...',
        auditAgentId: 'audit-secrets',
        auditAgentSlug: 'secrets',
      };
      expect(payload).toMatchSnapshot();
    });

    it('tool_call chunk from security audit', () => {
      const payload = {
        type: 'tool_call',
        projectId: 'proj_456',
        phase: 11,
        tool: 'Grep',
        auditAgentId: 'audit-secrets',
        auditAgentSlug: 'secrets',
      };
      expect(payload).toMatchSnapshot();
    });

    it('thinking chunk (bridged from harness:agent-stream phase 11)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 11,
        type: 'thinking',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // pipeline:phase-changed — emitido em transicoes de fase.
  // status: 'started' | 'completed' | 'loop-ready' | 'interrupted' | 'running'
  // phase: number | null  (null quando pipeline finaliza)
  // -------------------------------------------------------------------------

  describe('pipeline:phase-changed', () => {
    it('started (with currentModel)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 1,
        phaseName: 'Discovery',
        status: 'started',
        awaitingUser: true,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (auto phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 2,
        phaseName: 'Stories Generator',
        status: 'completed',
        awaitingUser: false,
      };
      expect(payload).toMatchSnapshot();
    });

    it('loop-ready (loop phase)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 13,
        phaseName: 'Coder',
        status: 'loop-ready',
        awaitingUser: false,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('running (loop phase, round > 1)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: 13,
        phaseName: 'Coder',
        status: 'running',
        awaitingUser: false,
        currentModel: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (pipeline final, phase=null)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: null,
        status: 'completed',
        awaitingUser: false,
      };
      expect(payload).toMatchSnapshot();
    });

    it('interrupted (recovery on boot)', () => {
      const payload = {
        projectId: 'proj_456',
        phase: null,
        status: 'interrupted',
        awaitingUser: true,
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // pipeline:project-updated — patch de colunas do projeto.
  // -------------------------------------------------------------------------

  describe('pipeline:project-updated', () => {
    it('status + currentPhase patch', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          status: 'running',
          currentPhase: 3,
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('status only patch', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          status: 'done',
        },
      };
      expect(payload).toMatchSnapshot();
    });

    it('currentPhase null (pipeline finished)', () => {
      const payload = {
        projectId: 'proj_456',
        patch: {
          currentPhase: null,
        },
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // pipeline:security-agent-status — emitido por SecurityAuditRunner em
  // transicoes de estado de cada agente do squad de auditoria.
  // -------------------------------------------------------------------------

  describe('pipeline:security-agent-status', () => {
    it('running', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'running',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed (with findings)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'completed',
        findingsCount: 3,
        outputFile: 'Security-scan_001-01-secrets.md',
      };
      expect(payload).toMatchSnapshot();
    });

    it('failed (with error)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        agentName: 'Secrets Hunter',
        status: 'failed',
        error: 'Timeout exceeded',
      };
      expect(payload).toMatchSnapshot();
    });
  });

  // -------------------------------------------------------------------------
  // pipeline:audit-agent-progress — progresso continuo (throttled) de cada
  // agente de auditoria. Mais campos que pipeline:security-agent-status.
  // -------------------------------------------------------------------------

  describe('pipeline:audit-agent-progress', () => {
    it('running progress', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'running',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 3,
        toolCallsCount: 11,
        costUsd: 0,
        durationMs: 12_500,
        findingsCount: undefined,
        model: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('completed progress (with findings)', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'completed',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 5,
        toolCallsCount: 18,
        costUsd: 0.0245,
        durationMs: 47_300,
        findingsCount: 3,
        model: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });

    it('failed progress', () => {
      const payload = {
        projectId: 'proj_456',
        agentId: 'audit-secrets',
        slug: 'secrets',
        agentName: 'Secrets Hunter',
        status: 'failed',
        filesAnalyzed: 42,
        additionalFilesAfterStart: 0,
        toolCallsCount: 2,
        costUsd: 0,
        durationMs: 1_200,
        findingsCount: undefined,
        model: 'claude-sonnet-4-5',
      };
      expect(payload).toMatchSnapshot();
    });
  });
});
