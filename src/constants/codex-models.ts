export interface CodexModelOption {
  slug: string;
  label: string;
  description: string;
}

export const CODEX_MODELS: CodexModelOption[] = [
  { slug: 'gpt-5.5',       label: 'GPT-5.5',       description: 'Frontier, codex-tuned (recomendado)' },
  { slug: 'gpt-5.4',       label: 'GPT-5.4',       description: 'Generalista frontier' },
  { slug: 'gpt-5.4-mini',  label: 'GPT-5.4-Mini',  description: 'Mais barato e rapido' },
  { slug: 'gpt-5.3-codex', label: 'GPT-5.3-Codex', description: 'Variante codex-tuned (legado)' },
  { slug: 'gpt-5.2',       label: 'GPT-5.2',       description: 'Anterior, generalista' },
];

export const CODEX_DEFAULT_MODEL = 'gpt-5.5';

export const CODEX_SANDBOX_OPTIONS = ['workspace-write', 'read-only', 'danger-full-access'] as const;
export const CODEX_REASONING_EFFORT = ['low', 'medium', 'high'] as const;
