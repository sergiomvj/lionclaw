import { useState } from 'react';
import {
  ThumbsUp,
  XCircle,
  AlertTriangle,
  Square,
  Rocket,
  CheckCircle2,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import { useActiveProjectState } from '@/hooks/useActiveProjectState';

// ---- FeedbackInput ----

interface FeedbackInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

function FeedbackInput({ value, onChange, placeholder }: FeedbackInputProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={2}
      className="w-full rounded-lg bg-zinc-800 border border-zinc-700 text-xs text-zinc-200 placeholder-zinc-600 px-3 py-2 resize-none focus:outline-none focus:border-zinc-500"
    />
  );
}

// ---- Phases that use Aprovar (conversational phases across pipelines) ----
// Dev pipeline conversations: 1, 3, 5, 6, 7, 8, 9, 10, 12
// Security pipeline conversations: 4, 5, 7, 9
// Union below; including phase 4 is harmless for dev (it is auto and never sets
// awaitingUser=true, so the button stays hidden there).
// The 'awaiting-dev-confirmation' status renders DevConfirmationButtons instead when triggered.
const APPROVAL_PHASES = new Set([1, 3, 4, 5, 6, 7, 8, 9, 10, 12]);

// ---- Approval button ----

interface ApprovalButtonsProps {
  disabled: boolean;
  onApprove: () => void;
  /** Override do label/icone padrao "Aprovar". Usado pela fase 4 architecture-review
   *  ("Fechar decisoes e gerar SPEC") pra deixar claro que isso fecha a entrevista
   *  e dispara um agente caro (spec-builder, opus, ~5-10min). */
  label?: string;
}

function ApprovalButtons({ disabled, onApprove, label = 'Aprovar' }: ApprovalButtonsProps) {
  return (
    <div className="flex gap-2 justify-center">
      <button
        onClick={onApprove}
        disabled={disabled}
        className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <ThumbsUp size={13} />
        {label}
      </button>
    </div>
  );
}

// ---- Max-loops paused buttons ----

interface MaxLoopsPausedButtonsProps {
  disabled: boolean;
  onAcceptWithRestrictions: () => void;
  onRejectSprint: (feedback: string) => void;
  onAbort: () => void;
}

function MaxLoopsPausedButtons({
  disabled,
  onAcceptWithRestrictions,
  onRejectSprint,
  onAbort,
}: MaxLoopsPausedButtonsProps) {
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState('');

  const handleRejectClick = () => {
    if (!showFeedback) {
      setShowFeedback(true);
      return;
    }
    onRejectSprint(feedback);
    setFeedback('');
    setShowFeedback(false);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 justify-center mb-1">
        <AlertTriangle size={12} className="text-amber-400" />
        <span className="text-[11px] text-amber-400 font-medium">
          Limite de loops atingido
        </span>
      </div>
      {showFeedback && (
        <FeedbackInput
          value={feedback}
          onChange={setFeedback}
          placeholder="Feedback para nova tentativa..."
        />
      )}
      <div className="flex flex-wrap gap-2 justify-center">
        <button
          onClick={onAcceptWithRestrictions}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <CheckCircle2 size={13} />
          Aceitar com Restricoes
        </button>
        <button
          onClick={handleRejectClick}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold bg-red-600/80 hover:bg-red-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <XCircle size={13} />
          {showFeedback ? 'Confirmar Rejeicao' : 'Rejeitar Sprint'}
        </button>
        <button
          onClick={onAbort}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-zinc-400 border border-zinc-700 hover:border-red-500/40 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square size={13} />
          Abortar Pipeline
        </button>
        {showFeedback && (
          <button
            onClick={() => { setShowFeedback(false); setFeedback(''); }}
            className="px-3 py-2 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Phase 9 -> 10 confirmation: "Go para desenvolvimento" ----

interface DevConfirmationButtonsProps {
  disabled: boolean;
  onConfirm: () => void;
  onAbort: () => void;
}

function DevConfirmationButtons({ disabled, onConfirm, onAbort }: DevConfirmationButtonsProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-amber-300 text-center font-medium">
        Plano de sprints aprovado. Iniciar desenvolvimento?
      </p>
      <div className="flex gap-2 justify-center">
        <button
          onClick={onConfirm}
          disabled={disabled}
          className="flex items-center gap-1.5 px-5 py-2 text-xs font-semibold bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Rocket size={13} />
          Iniciar Desenvolvimento
        </button>
        <button
          onClick={onAbort}
          disabled={disabled}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-zinc-400 border border-zinc-700 hover:border-red-500/40 hover:text-red-400 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Square size={13} />
          Abortar
        </button>
      </div>
    </div>
  );
}

// ---- Main export ----

interface PhaseActionButtonsProps {
  /** Current pipeline phase number (1-14). Null = not started. */
  currentPhase: number | null;
  /** Whether the pipeline is paused due to max loops reached. */
  pausedByMaxLoops?: boolean;
  /** When true, hides all action buttons (used for completed phase history view). */
  readOnly?: boolean;
}

export function PhaseActionButtons({
  currentPhase,
  pausedByMaxLoops = false,
  readOnly = false,
}: PhaseActionButtonsProps) {
  const isStreaming = useActiveProjectState(s => s.isStreaming) ?? false;
  const awaitingUser = useActiveProjectState(s => s.awaitingUser) ?? false;
  const agentCompleted = useActiveProjectState(s => s.agentCompleted) ?? false;
  const phaseStatus = useActiveProjectState(s => s.phaseStatus) ?? '';
  // pipelineType vem da lista de projects (nao mora em PerProjectState). Default
  // 'development' pra retro-compat com rows antigas sem pipelineType setado.
  const pipelineType = usePipelineStore(s => {
    const p = s.projects.find((proj) => proj.id === s.activeProjectId);
    return p?.pipelineType ?? 'development';
  });
  const getCurrentMessages = usePipelineStore(s => s.getCurrentMessages);
  const approvePhase = usePipelineStore(s => s.approvePhase);
  const abortPipeline = usePipelineStore(s => s.abortPipeline);
  const confirmDevelopment = usePipelineStore(s => s.confirmDevelopment);

  const disabled = isStreaming;
  const messages = getCurrentMessages();

  // Read-only mode: hide all action buttons (completed phase history view)
  if (readOnly) return null;

  // Nothing to show if agent is still replying or we are not awaiting user
  if (!awaitingUser || isStreaming) return null;

  const handleApprove = () => void approvePhase();
  const handleAbort = () => void abortPipeline();

  // Need at least 1 assistant message before enabling approval
  const hasAssistantMessage = messages.some((m) => m.role === 'assistant');

  const containerClass =
    'border-t border-amber-500/20 bg-amber-500/5 px-4 py-3 shrink-0';
  const innerClass = 'max-w-2xl mx-auto';
  const titleClass = 'text-xs text-amber-400 font-medium text-center mb-3';

  // ---- Max loops paused (any phase) ----
  if (pausedByMaxLoops) {
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <MaxLoopsPausedButtons
            disabled={disabled}
            onAcceptWithRestrictions={() => void approvePhase({ acceptWithRestrictions: true })}
            onRejectSprint={(feedback: string) => void approvePhase({ feedback })}
            onAbort={handleAbort}
          />
        </div>
      </div>
    );
  }

  if (currentPhase === null) return null;

  // ---- Architecture-review phase 2 (Triage): no generic approve button ----
  // The approval payload requires { selectedCandidateId }, which only the
  // candidate cards in ArchitectureReviewArtifactView can provide via the
  // "Aprovar este alvo" button per card. A generic "Aprovar" here would chamar
  // approvePhase() sem payload e quebrar (Sprint 3 valida no engine).
  // Guard explicito: nunca renderizar approve generico na fase 2 architecture-review.
  // (APPROVAL_PHASES atualmente nao inclui 2, mas isso protege contra regressao.)
  // pipelineType nao chega aqui — usar o store ou o phaseStatus derivado.
  // Heuristica suficiente: phase===2 + ausencia de blockId no metadata identifica
  // o caso architecture-review (security/dev/feature nao usam phase 2 conversation).

  // ---- Phase 12 awaiting-dev-confirmation: "Iniciar Desenvolvimento" ----
  if (phaseStatus === 'awaiting-dev-confirmation') {
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <DevConfirmationButtons
            disabled={disabled}
            onConfirm={() => void confirmDevelopment()}
            onAbort={() => void abortPipeline()}
          />
        </div>
      </div>
    );
  }

  // ---- Conversational phases (1, 3, 5-10) — Aprovar ----
  // Show Approve button whenever the agent is not streaming and there is at least
  // one assistant message. The [PHASE_COMPLETE] marker (agentCompleted) is no
  // longer a hard gate — it is used only for the hint text.
  if (APPROVAL_PHASES.has(currentPhase)) {
    const approvalDisabled = disabled || !hasAssistantMessage;
    // Architecture-review fase 4 (Decision Interview): label e hint customizados
    // pra deixar claro que isso fecha a entrevista e dispara o spec-builder
    // (auto, opus, ~5-10min). Botao "Aprovar" generico era ambiguo aqui.
    const isArchPhase4 =
      pipelineType === 'architecture-review' && currentPhase === 4;
    const approvalLabel = isArchPhase4
      ? 'Fechar decisoes e gerar SPEC'
      : 'Aprovar';
    const hintText = isArchPhase4
      ? agentCompleted
        ? 'Entrevista cobriu o essencial. Fechar dispara a geracao da SPEC (~5-10min).'
        : 'Continue a entrevista ou feche quando achar que cobriu o essencial. Fechar gera a SPEC automaticamente.'
      : agentCompleted
        ? 'Agente concluiu esta fase. Clique em Aprovar para avancar.'
        : 'Voce pode continuar conversando ou clicar em Aprovar para avancar.';
    return (
      <div className={containerClass}>
        <div className={innerClass}>
          <p className={titleClass}>{hintText}</p>
          <ApprovalButtons
            disabled={approvalDisabled}
            onApprove={handleApprove}
            label={approvalLabel}
          />
        </div>
      </div>
    );
  }

  // ---- Default: no contextual buttons for other phases ----
  return null;
}
