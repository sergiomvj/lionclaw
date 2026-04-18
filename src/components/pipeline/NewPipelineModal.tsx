import { useState, useEffect, useRef } from 'react';
import { X, Folder, Loader2, ChevronRight, ChevronLeft, FileText } from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';

// ---- 4 Entry points as per spec ----

interface EntryPoint {
  phase: number;
  label: string;
  description: string;
}

const ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Discovery',
    description: 'Comecar do zero — entrevista de produto, PRD, SPEC e implementacao',
  },
  {
    phase: 3,
    label: 'Spec Validator + Enricher',
    description: 'Ja tem um PRD — validar e enriquecer a SPEC antes de planejar',
  },
  {
    phase: 8,
    label: 'Planner',
    description: 'Ja tem SPEC aprovada — gerar sprints e planejar a implementacao',
  },
];

// ---- Field-level validation errors ----

interface FieldErrors {
  name?: string;
  description?: string;
  projectPath?: string;
}

// ---- Props ----

interface NewPipelineModalProps {
  onClose: () => void;
  onCreated: (projectId: string, startPhase: number) => Promise<void>;
}

export function NewPipelineModal({ onClose, onCreated }: NewPipelineModalProps) {
  const { createProject, projects } = usePipelineStore();

  // Step 1: project data; Step 2: entry point
  const [step, setStep] = useState<1 | 2>(1);

  // Step 1 fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');

  // Suggested candidate paths (not verified — shown as hints only)
  const [suggestedSpecPath, setSuggestedSpecPath] = useState<string | null>(null);
  const [suggestedPrdPath, setSuggestedPrdPath] = useState<string | null>(null);

  // Step 2 field
  const [selectedPhase, setSelectedPhase] = useState<number>(1);

  // UI state
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus name on open
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  // Derive suggested candidate paths when the project path changes.
  // These are not verified against the filesystem — just conventional name hints.
  useEffect(() => {
    const path = projectPath.trim();
    if (!path) {
      setSuggestedSpecPath(null);
      setSuggestedPrdPath(null);
      return;
    }
    const base = path.replace(/\/$/, '');
    setSuggestedSpecPath(`${base}/SPEC.md`);
    setSuggestedPrdPath(`${base}/PRD.md`);
  }, [projectPath]);

  const handlePickDirectory = async () => {
    const dir = await window.lionclaw.shell.selectDirectory();
    if (dir) setProjectPath(dir);
  };

  // ---- Validate step 1 ----

  const validateStep1 = (): FieldErrors => {
    const errors: FieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.name = 'Nome e obrigatorio.';
    } else if (trimmedName.length < 3) {
      errors.name = 'Nome deve ter pelo menos 3 caracteres.';
    } else if (trimmedName.length > 100) {
      errors.name = 'Nome deve ter no maximo 100 caracteres.';
    } else {
      const duplicate = projects.some(
        (p) => p.name.toLowerCase() === trimmedName.toLowerCase(),
      );
      if (duplicate) {
        errors.name = 'Ja existe um pipeline com esse nome.';
      }
    }

    if (description.trim().length > 500) {
      errors.description = 'Descricao deve ter no maximo 500 caracteres.';
    }

    if (!projectPath.trim()) {
      errors.projectPath = 'Caminho do projeto e obrigatorio.';
    }

    return errors;
  };

  // Show errors in real-time after the user has interacted with a field
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const liveErrors = validateStep1();
  const isStep1Valid = Object.keys(liveErrors).length === 0;

  // Merge: show live errors for touched fields + all errors after explicit submit attempt
  const visibleErrors: FieldErrors = {};
  for (const key of Object.keys(liveErrors) as Array<keyof FieldErrors>) {
    if (touched[key] || fieldErrors[key]) {
      visibleErrors[key] = liveErrors[key];
    }
  }

  const handleNextStep = () => {
    setFieldErrors(liveErrors);
    setTouched({ name: true, description: true, projectPath: true });
    if (Object.keys(liveErrors).length === 0) {
      setStep(2);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setSubmitError(null);

    try {
      const projectId = await createProject({
        name: name.trim(),
        description: description.trim(),
        projectPath: projectPath.trim(),
        startPhase: selectedPhase,
        specPath: suggestedSpecPath ?? undefined,
        prdPath: suggestedPrdPath ?? undefined,
      });

      await onCreated(projectId, selectedPhase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Novo Pipeline</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {step === 1 ? 'Dados do projeto (1/2)' : 'Ponto de entrada (2/2)'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Step indicator dots */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-1">
          <div className={`w-2 h-2 rounded-full transition-colors ${step === 1 ? 'bg-amber-500' : 'bg-green-500'}`} />
          <div className={`w-2 h-2 rounded-full transition-colors ${step === 2 ? 'bg-amber-500' : 'bg-zinc-700'}`} />
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {step === 1 ? (
            <>
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Nome do projeto <span className="text-red-400">*</span>
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, name: true }))}
                  placeholder="Meu Projeto"
                  className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors ${
                    visibleErrors.name ? 'border-red-500/60' : 'border-zinc-700'
                  }`}
                />
                {visibleErrors.name && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.name}
                  </p>
                )}
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Descricao <span className="text-zinc-600">(opcional)</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, description: true }))}
                  placeholder="Breve descricao do projeto"
                  className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors ${
                    visibleErrors.description ? 'border-red-500/60' : 'border-zinc-700'
                  }`}
                />
                {visibleErrors.description && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.description}
                  </p>
                )}
                <p className="text-[11px] text-zinc-600 mt-1 text-right">
                  {description.length}/500
                </p>
              </div>

              {/* Project path */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Caminho do projeto <span className="text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                    onBlur={() => setTouched((prev) => ({ ...prev, projectPath: true }))}
                    placeholder="/Users/eu/meu-projeto"
                    className={`flex-1 min-w-0 bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors font-mono text-xs ${
                      visibleErrors.projectPath ? 'border-red-500/60' : 'border-zinc-700'
                    }`}
                  />
                  <button
                    onClick={() => { void handlePickDirectory(); }}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                    title="Selecionar pasta"
                  >
                    <Folder size={14} />
                    Escolher
                  </button>
                </div>
                {visibleErrors.projectPath && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.projectPath}
                  </p>
                )}

                {/* Suggested path hints — not verified, confirmed only on project creation */}
                {projectPath.trim() && (suggestedSpecPath || suggestedPrdPath) && (
                  <div className="mt-2 space-y-1">
                    {suggestedSpecPath && (
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <FileText size={11} />
                        <span>SPEC.md — Caminho sugerido, sera verificado ao criar</span>
                      </div>
                    )}
                    {suggestedPrdPath && (
                      <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                        <FileText size={11} />
                        <span>PRD.md — Caminho sugerido, sera verificado ao criar</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* Step 2: Entry point selection */}
              <div className="space-y-2">
                {ENTRY_POINTS.map((ep) => (
                  <button
                    key={ep.phase}
                    onClick={() => setSelectedPhase(ep.phase)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all ${
                      selectedPhase === ep.phase
                        ? 'bg-amber-500/10 border-amber-500/50'
                        : 'bg-zinc-800/50 border-zinc-700 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-100">{ep.label}</span>
                      <div
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                          selectedPhase === ep.phase
                            ? 'border-amber-500 bg-amber-500'
                            : 'border-zinc-600'
                        }`}
                      >
                        {selectedPhase === ep.phase && (
                          <div className="w-1.5 h-1.5 rounded-full bg-white" />
                        )}
                      </div>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">{ep.description}</p>
                  </button>
                ))}
              </div>

              {/* Submit error */}
              {submitError && (
                <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-xs text-red-300">{submitError}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 px-5 py-4 border-t border-zinc-800">
          {step === 1 ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleNextStep}
                disabled={!isStep1Valid}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Proximo
                <ChevronRight size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                disabled={creating}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-40"
              >
                <ChevronLeft size={14} />
                Voltar
              </button>
              <button
                onClick={() => { void handleCreate(); }}
                disabled={creating}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar Pipeline'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
