import keytar from 'keytar';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';

const logger = createLogger('secrets');
const SERVICE_NAME = 'LionClaw';
const KEYTAR_TIMEOUT_MS = 3000;
const SECRETS_FILE_DIR = path.join(getLionClawHome(), 'data');
const SECRETS_FILE_PATH = path.join(SECRETS_FILE_DIR, '.secrets');

// ---- Encryption helpers ----

/**
 * Derives a 32-byte AES key from machine-specific identifiers so the
 * encrypted file is tied to this user+machine combination.
 * Salt is fixed so key derivation is deterministic across process restarts.
 */
function deriveEncryptionKey(): Buffer {
  const machineId = `${os.hostname()}::${os.userInfo().username}`;
  const salt = Buffer.from('lionclaw-secrets-v1-salt-2024', 'utf8');
  return crypto.scryptSync(machineId, salt, 32);
}

interface EncryptedStore {
  [key: string]: {
    iv: string;
    authTag: string;
    ciphertext: string;
  };
}

function readSecretStore(): EncryptedStore {
  try {
    if (!fs.existsSync(SECRETS_FILE_PATH)) return {};
    const raw = fs.readFileSync(SECRETS_FILE_PATH, 'utf8');
    return JSON.parse(raw) as EncryptedStore;
  } catch (error) {
    logger.warn({ error }, 'secrets-file: failed to read store, starting fresh');
    return {};
  }
}

function writeSecretStore(store: EncryptedStore): void {
  fs.mkdirSync(SECRETS_FILE_DIR, { recursive: true });
  fs.writeFileSync(SECRETS_FILE_PATH, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
}

function encryptValue(plaintext: string): { iv: string; authTag: string; ciphertext: string } {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decryptValue(entry: { iv: string; authTag: string; ciphertext: string }): string {
  const key = deriveEncryptionKey();
  const iv = Buffer.from(entry.iv, 'hex');
  const authTag = Buffer.from(entry.authTag, 'hex');
  const ciphertext = Buffer.from(entry.ciphertext, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ---- File-based fallback ----

function fileGetSecret(key: string): string | null {
  try {
    const store = readSecretStore();
    const entry = store[key];
    if (!entry) return null;
    return decryptValue(entry);
  } catch (error) {
    logger.error({ key, error }, 'secrets-file: failed to get secret');
    return null;
  }
}

function fileSetSecret(key: string, value: string): void {
  const store = readSecretStore();
  store[key] = encryptValue(value);
  writeSecretStore(store);
  logger.info({ key }, 'secrets-file: secret stored');
}

function fileDeleteSecret(key: string): void {
  const store = readSecretStore();
  if (key in store) {
    delete store[key];
    writeSecretStore(store);
    logger.info({ key }, 'secrets-file: secret deleted');
  }
}

// ---- Keytar helpers with timeout ----

function keytarTimeout(): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error('keytar timed out')), KEYTAR_TIMEOUT_MS),
  );
}

async function keytarGet(key: string): Promise<string | null> {
  return Promise.race([keytar.getPassword(SERVICE_NAME, key), keytarTimeout()]);
}

async function keytarSet(key: string, value: string): Promise<void> {
  return Promise.race([keytar.setPassword(SERVICE_NAME, key, value), keytarTimeout()]);
}

async function keytarDelete(key: string): Promise<void> {
  // deletePassword returns boolean; we discard the value
  await Promise.race([keytar.deletePassword(SERVICE_NAME, key), keytarTimeout()]);
}

// ---- Public API ----

export async function getSecret(key: string): Promise<string | null> {
  try {
    const value = await keytarGet(key);
    logger.debug({ key }, 'keytar: secret retrieved');
    return value;
  } catch (error) {
    logger.warn({ key, error }, 'keytar unavailable for get, falling back to encrypted file');
  }

  return fileGetSecret(key);
}

export async function setSecret(key: string, value: string): Promise<void> {
  let keytarOk = false;

  try {
    await keytarSet(key, value);
    keytarOk = true;
    logger.info({ key }, 'keytar: secret stored');
  } catch (error) {
    logger.warn({ key, error }, 'keytar unavailable for set, falling back to encrypted file');
  }

  // Always write to file as well so the fallback path has fresh data.
  // This means future reads succeed even if keytar later becomes unavailable.
  try {
    fileSetSecret(key, value);
  } catch (fileError) {
    if (!keytarOk) {
      // Both backends failed: surface the error so the caller knows.
      logger.error({ key, fileError }, 'secrets-file: also failed to store secret');
      throw new Error(`Falha ao salvar secret: ${key}`);
    }
    // keytar succeeded, file write failed: log but do not fail.
    logger.warn({ key, fileError }, 'secrets-file: write failed but keytar succeeded');
  }
}

export async function deleteSecret(key: string): Promise<void> {
  try {
    await keytarDelete(key);
    logger.info({ key }, 'keytar: secret deleted');
  } catch (error) {
    logger.warn({ key, error }, 'keytar unavailable for delete, proceeding with file cleanup');
  }

  try {
    fileDeleteSecret(key);
  } catch (fileError) {
    logger.error({ key, fileError }, 'secrets-file: failed to delete secret');
  }
}

export async function getApiKey(): Promise<string | null> {
  return getSecret('ANTHROPIC_API_KEY');
}

export async function setApiKey(key: string): Promise<void> {
  return setSecret('ANTHROPIC_API_KEY', key);
}
