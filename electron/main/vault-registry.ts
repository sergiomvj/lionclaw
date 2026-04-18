import { createLogger } from './logger';
import { getSecret, setSecret, deleteSecret } from './secrets-vault';

const logger = createLogger('vault-registry');

export interface VaultEntry {
  key: string;
  label: string;
  description: string;
  service: string;
  required: boolean;
  configured: boolean;
  placeholder?: string;
  docsUrl?: string;
}

const VAULT_ENTRIES: Omit<VaultEntry, 'configured'>[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API Key',
    description: 'Chave da API do Claude. Obrigatoria para o agente funcionar.',
    service: 'anthropic',
    required: true,
    placeholder: 'sk-ant-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'ELEVENLABS_API_KEY',
    label: 'ElevenLabs API Key',
    description: 'Chave da ElevenLabs para voz sintetica (TTS). Necessaria para o agente falar.',
    service: 'elevenlabs',
    required: false,
    placeholder: 'xi-...',
    docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API Key',
    description: 'Chave da OpenAI para embeddings (memoria semantica) e transcricao de audio (Whisper).',
    service: 'openai',
    required: false,
    placeholder: 'sk-...',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'SHOPIFY_STORE_URL',
    label: 'Shopify Store URL',
    description: 'URL da loja Shopify (ex: minha-loja.myshopify.com). Necessario para o MCP Shopify.',
    service: 'shopify',
    required: false,
    placeholder: 'minha-loja.myshopify.com',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'SHOPIFY_CLIENT_ID',
    label: 'Shopify Client ID',
    description: 'Client ID do app Shopify. Encontre em Dev Dashboard > App > Settings.',
    service: 'shopify',
    required: false,
    placeholder: 'shp_...',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'SHOPIFY_CLIENT_SECRET',
    label: 'Shopify Client Secret',
    description: 'Client Secret do app Shopify. Encontre em Dev Dashboard > App > Settings.',
    service: 'shopify',
    required: false,
    placeholder: 'shps_...',
    docsUrl: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-secrets',
  },
  {
    key: 'GOOGLE_GEMINI_API_KEY',
    label: 'Google Gemini API Key',
    description: 'Chave da API Gemini (Google AI Studio). Necessario para geracao de imagens com Nano Banana. Gratuito ate 500 imagens/dia.',
    service: 'google',
    required: false,
    placeholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/apikey',
  },
  {
    key: 'COHERE_API_KEY',
    label: 'Cohere API Key',
    description: 'Chave da API Cohere. Necessaria para reranking na Knowledge Base (melhora a qualidade dos resultados de busca).',
    service: 'cohere',
    required: false,
    placeholder: 'co-...',
    docsUrl: 'https://dashboard.cohere.com/api-keys',
  },
];

let statusCache: Map<string, boolean> = new Map();

export async function getVaultEntries(): Promise<VaultEntry[]> {
  const entries: VaultEntry[] = [];
  for (const entry of VAULT_ENTRIES) {
    let configured = statusCache.get(entry.key) ?? false;
    if (!statusCache.has(entry.key)) {
      const value = await getSecret(entry.key);
      configured = value !== null && value.length > 0;
      statusCache.set(entry.key, configured);
    }
    entries.push({ ...entry, configured });
  }
  return entries;
}

export async function setVaultSecret(key: string, value: string): Promise<void> {
  const entry = VAULT_ENTRIES.find(e => e.key === key);
  if (!entry) {
    throw new Error(`Chave desconhecida: ${key}. Use registerVaultEntry() primeiro.`);
  }
  await setSecret(key, value);
  statusCache.set(key, true);
  logger.info({ key, service: entry.service }, 'vault: secret updated');
}

export async function deleteVaultSecret(key: string): Promise<void> {
  await deleteSecret(key);
  statusCache.set(key, false);
  logger.info({ key }, 'vault: secret deleted');
}

export async function checkVaultSecret(key: string): Promise<boolean> {
  const value = await getSecret(key);
  const configured = value !== null && value.length > 0;
  statusCache.set(key, configured);
  return configured;
}

export function registerVaultEntry(entry: Omit<VaultEntry, 'configured'>): void {
  const exists = VAULT_ENTRIES.find(e => e.key === entry.key);
  if (!exists) {
    VAULT_ENTRIES.push(entry);
    logger.info({ key: entry.key, service: entry.service }, 'vault: new entry registered');
  }
}

export { getSecret } from './secrets-vault';
