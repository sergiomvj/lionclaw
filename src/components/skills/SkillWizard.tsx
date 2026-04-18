import { useState } from 'react';
import { Wand2, ChevronLeft, ChevronRight, Check, X } from 'lucide-react';
import type { SkillInput } from '@/types';

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit',
];

type SkillType = 'referencia' | 'tarefa' | 'hibrida';

interface WizardData {
  name: string;
  description: string;
  type: SkillType;
  allowedTools: string[];
  instructions: string;
}

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

function buildSkillContent(data: WizardData): string {
  let content = '';

  if (data.type === 'referencia') {
    content += '## Guidelines\n\n';
  } else if (data.type === 'tarefa') {
    content += '## Workflow\n\n';
  } else {
    content += '## Instrucoes\n\n';
  }

  content += data.instructions;
  return content;
}

function buildSkillPreview(data: WizardData): string {
  const toolsLine = data.allowedTools.length > 0
    ? `allowed-tools: [${data.allowedTools.map(t => `"${t}"`).join(', ')}]\n`
    : '';

  const frontmatter = `---\nname: ${data.name}\ndescription: "${data.description}"\n${toolsLine}---\n\n`;
  return frontmatter + buildSkillContent(data);
}

const STEP_LABELS = ['Definicao', 'Instrucoes', 'Revisao'];

export function SkillWizard({ onClose, onCreated }: Props) {
  const [step, setStep] = useState(0);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<SkillType>('tarefa');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [instructions, setInstructions] = useState('');

  const wizardData: WizardData = { name, description, type, allowedTools, instructions };

  const canGoNext = () => {
    if (step === 0) return name.trim().length > 0 && description.trim().length > 0;
    if (step === 1) return instructions.trim().length > 0;
    return true;
  };

  const handleToolToggle = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const handleCreate = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const input: SkillInput = {
        name: name.trim(),
        description: description.trim(),
        content: buildSkillContent(wizardData),
        allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      };
      await window.lionclaw.skills.create(input);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao criar skill');
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <Wand2 size={18} className="text-amber-500" />
            <h2 className="text-base font-semibold text-zinc-100">Criar Skill com Assistente</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
            <X size={18} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-3 px-5 py-3 border-b border-zinc-800">
          {STEP_LABELS.map((label, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold transition-colors ${
                idx < step
                  ? 'bg-amber-600 text-white'
                  : idx === step
                    ? 'bg-amber-600/20 border border-amber-600 text-amber-400'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-600'
              }`}>
                {idx < step ? <Check size={12} /> : idx + 1}
              </div>
              <span className={`text-xs ${idx === step ? 'text-zinc-200' : 'text-zinc-600'}`}>
                {label}
              </span>
              {idx < STEP_LABELS.length - 1 && (
                <div className={`w-8 h-px ${idx < step ? 'bg-amber-600' : 'bg-zinc-700'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">

          {/* Step 0: Definicao */}
          {step === 0 && (
            <div className="space-y-5">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">
                  Nome da Skill
                  <span className="text-zinc-600 ml-1">(lowercase, hifens)</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                  placeholder="minha-skill"
                  autoFocus
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Descricao</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="O que esta skill faz e quando usar"
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Tipo</label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as SkillType)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                >
                  <option value="referencia">Referencia (guidelines, documentacao)</option>
                  <option value="tarefa">Tarefa (workflow, execucao passo a passo)</option>
                  <option value="hibrida">Hibrida (combinacao de guidelines e workflow)</option>
                </select>
              </div>

              <div className="border border-zinc-800 rounded-lg p-4">
                <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
                  Ferramentas Permitidas
                  <span className="text-zinc-600 ml-1 normal-case">(opcional)</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {AVAILABLE_TOOLS.map(tool => (
                    <button
                      key={tool}
                      onClick={() => handleToolToggle(tool)}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                        allowedTools.includes(tool)
                          ? 'bg-amber-600/20 border-amber-600/50 text-amber-400'
                          : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                      }`}
                    >
                      {tool}
                    </button>
                  ))}
                </div>
                {allowedTools.length === 0 && (
                  <p className="text-xs text-zinc-600 mt-2">Nenhum selecionado = herda do agente</p>
                )}
              </div>
            </div>
          )}

          {/* Step 1: Instrucoes */}
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Instrucoes para o Agente</label>
                <p className="text-xs text-zinc-600 mb-3">
                  Descreva em detalhes o que a skill deve fazer, quando ativar, e exemplos de uso.
                </p>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={`Exemplo para uma skill de revisao de codigo:\n\nQuando o usuario pedir para revisar codigo, analisar pull requests, ou verificar qualidade de implementacao:\n\n1. Leia os arquivos relevantes com Read/Glob\n2. Verifique: tipos TypeScript, tratamento de erros, nomenclatura, duplicacao\n3. Liste problemas por severidade (critico, aviso, sugestao)\n4. Sugira correcoes especificas com exemplos de codigo\n5. Pontue pontos positivos tambem\n\nFormato de saida: lista estruturada com secoes por arquivo.`}
                  rows={16}
                  autoFocus
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 font-mono outline-none focus:border-amber-600 resize-y"
                  spellCheck={false}
                />
              </div>
            </div>
          )}

          {/* Step 2: Revisao */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">
                  Preview do SKILL.md
                </p>
                <pre className="bg-zinc-950 border border-zinc-800 rounded-lg p-4 text-xs text-zinc-300 font-mono overflow-x-auto whitespace-pre-wrap">
                  {buildSkillPreview(wizardData)}
                </pre>
              </div>

              <div className="bg-zinc-800/50 border border-zinc-700 rounded-lg p-4 space-y-2">
                <p className="text-xs font-medium text-zinc-300">Resumo</p>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <span className="text-zinc-500">Nome:</span>{' '}
                    <span className="text-zinc-200">{name}</span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Tipo:</span>{' '}
                    <span className="text-zinc-200">{type}</span>
                  </div>
                </div>
                {allowedTools.length > 0 && (
                  <div className="text-xs">
                    <span className="text-zinc-500">Ferramentas: </span>
                    <span className="text-zinc-300">{allowedTools.join(', ')}</span>
                  </div>
                )}
              </div>

              {error && (
                <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-3 py-2 text-xs text-red-400">
                  {error}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-zinc-800">
          <button
            onClick={step === 0 ? onClose : () => setStep(s => s - 1)}
            className="flex items-center gap-2 px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            {step === 0 ? (
              'Cancelar'
            ) : (
              <>
                <ChevronLeft size={16} />
                Voltar
              </>
            )}
          </button>

          {step < 2 ? (
            <button
              onClick={() => setStep(s => s + 1)}
              disabled={!canGoNext()}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition-colors"
            >
              Proximo
              <ChevronRight size={16} />
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={isSaving}
              className="flex items-center gap-2 px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition-colors"
            >
              {isSaving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Criando...
                </>
              ) : (
                <>
                  <Check size={16} />
                  Criar Skill
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
