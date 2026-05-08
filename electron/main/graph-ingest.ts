import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import dns from 'dns';
import { URL } from 'url';
import { BrowserWindow } from 'electron';
import { createLogger } from './logger';
import { getSetting, insertIngestJob, updateIngestJob, getIngestJob, getIngestJobByHash, getAllIngestJobs } from './db';
import {
  getVaultRoot,
  executeVaultOperation,
  regenerateVaultIndex,
  updateVaultHot,
  snapshotBeforeUpdate,
  cleanOldSnapshots,
  getExistingVaultFilesList,
  appendVaultLog,
  deleteVaultNote,
} from './mgraph-engine';
import type { IngestEstimate, IngestSettings, IngestJob, VaultOperation } from '../../src/types';

const logger = createLogger('graph-ingest');
const execAsync = promisify(exec);
const dnsResolve = promisify(dns.resolve4);

// ---- Constants ----

const MAX_CHUNKS_PER_JOB = 30;
const CHUNK_SIZE = 25000;
const CHUNK_OVERLAP_RATIO = 0.1;
const QUALITY_THRESHOLD = 200; // chars per page for PDF quality
const URL_MIN_CONTENT = 200; // minimum chars for URL extraction to be considered good
const MAX_PDF_VISION_PAGES = 20;
const MAX_AUDIO_MINUTES = 60;

// Claude pricing (per token)
const CLAUDE_INPUT_PRICE_PER_TOKEN = 3 / 1_000_000;   // $3/MTok
const CLAUDE_OUTPUT_PRICE_PER_TOKEN = 15 / 1_000_000;  // $15/MTok
const ESTIMATED_OUTPUT_TOKENS_PER_CHUNK = 800;

// SSRF protection
const PRIVATE_RANGES = [
  { prefix: '127.', mask: 8 },
  { prefix: '10.', mask: 8 },
  { prefix: '172.16.', mask: 12 },
  { prefix: '172.17.', mask: 12 },
  { prefix: '172.18.', mask: 12 },
  { prefix: '172.19.', mask: 12 },
  { prefix: '172.20.', mask: 12 },
  { prefix: '172.21.', mask: 12 },
  { prefix: '172.22.', mask: 12 },
  { prefix: '172.23.', mask: 12 },
  { prefix: '172.24.', mask: 12 },
  { prefix: '172.25.', mask: 12 },
  { prefix: '172.26.', mask: 12 },
  { prefix: '172.27.', mask: 12 },
  { prefix: '172.28.', mask: 12 },
  { prefix: '172.29.', mask: 12 },
  { prefix: '172.30.', mask: 12 },
  { prefix: '172.31.', mask: 12 },
  { prefix: '192.168.', mask: 16 },
  { prefix: '169.254.', mask: 16 },
  { prefix: '0.', mask: 8 },
];

// ---- Settings helpers ----

function getIngestSettings(): IngestSettings {
  return {
    visionModel: (getSetting('ingest_vision_model') as string) || 'claude-sonnet-4-6',
    extractionModel: (getSetting('ingest_extraction_model') as string) || 'claude-sonnet-4-6',
    sttProvider: (getSetting('ingest_stt_provider') as 'elevenlabs' | 'whisper') || 'whisper',
    maxFileSizeMb: Number(getSetting('ingest_max_file_size_mb')) || 100,
    maxChunks: Number(getSetting('ingest_max_chunks')) || MAX_CHUNKS_PER_JOB,
    autoConfirm: getSetting('ingest_auto_confirm') === 'true',
    pdfExtractor: (getSetting('ingest_pdf_extractor') as 'auto' | 'pdfjs' | 'vision') || 'auto',
    urlLevel: (Number(getSetting('ingest_url_level')) as 1 | 2 | 3) || 3,
  };
}

// ---- SSRF Protection ----

function isPrivateIP(ip: string): boolean {
  for (const range of PRIVATE_RANGES) {
    if (ip.startsWith(range.prefix)) return true;
  }
  // IPv6 loopback
  if (ip === '::1' || ip === '::') return true;
  return false;
}

export async function validateUrlSafety(urlStr: string): Promise<{ safe: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, error: 'Invalid URL' };
  }

  // Schema check
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, error: `Schema not allowed: ${parsed.protocol}` };
  }

  // Port check
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { safe: false, error: `Port not allowed: ${parsed.port}` };
  }

  // DNS resolve and check for private IPs
  try {
    const addresses = await dnsResolve(parsed.hostname);
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        return { safe: false, error: `Private IP resolved: ${addr}` };
      }
    }
  } catch {
    // If DNS fails, it might be an IP literal
    if (isPrivateIP(parsed.hostname)) {
      return { safe: false, error: `Private IP not allowed: ${parsed.hostname}` };
    }
  }

  return { safe: true };
}

// ---- Claude API helpers ----

async function callClaudeVision(
  imageBase64: string,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { getApiKey } = await import('./secrets-vault');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const settings = getIngestSettings();
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model: settings.visionModel,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: imageBase64,
            },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('');
}

// ---- PDF Extractors ----

/**
 * Extract text from PDF using unpdf (pdfjs-based).
 * Returns { text, quality } where quality is 'good' if >200 chars/page.
 */
export async function extractPdfText(filePath: string): Promise<{ text: string; quality: 'good' | 'poor' }> {
  const { getDocumentProxy, extractText } = await import('unpdf');

  const buffer = fs.readFileSync(filePath);
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });

  const charsPerPage = totalPages > 0 ? text.length / totalPages : 0;
  const quality = charsPerPage > QUALITY_THRESHOLD ? 'good' : 'poor';

  logger.info({ filePath, totalPages, charsPerPage: Math.round(charsPerPage), quality }, 'PDF text extracted via unpdf');
  return { text, quality };
}

/**
 * Extract text from PDF using Claude Vision (OCR).
 * Converts pages to images via pdfjs-dist and sends to Claude Vision.
 * Limited to MAX_PDF_VISION_PAGES pages.
 */
export async function extractPdfVision(filePath: string): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');
  const { createCanvas } = await import('canvas');

  const buffer = fs.readFileSync(filePath);
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({ data, useSystemFonts: true });
  const pdf = await loadingTask.promise;
  const totalPages = pdf.numPages;
  const pagesToProcess = Math.min(totalPages, MAX_PDF_VISION_PAGES);

  logger.info({ filePath, totalPages, pagesToProcess }, 'PDF Vision OCR starting');

  const pageTexts: string[] = [];
  const SCALE = 2.0; // render at 2x for better OCR quality

  for (let i = 1; i <= pagesToProcess; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: SCALE });

    // Render page to canvas as PNG
    const canvas = createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
    }).promise;

    const pngBuffer = canvas.toBuffer('image/png');
    const pngBase64 = pngBuffer.toString('base64');

    // Send page image to Claude Vision for OCR
    const pageText = await callClaudeVision(
      pngBase64,
      'image/png',
      `Extract ALL text from this PDF page image (page ${i} of ${totalPages}). Preserve structure including headings, paragraphs, lists, and tables. Output raw text only, no commentary.`,
    );

    pageTexts.push(pageText);
    logger.info({ filePath, page: i, textLength: pageText.length }, 'PDF page OCR complete');
  }

  const text = pageTexts.join('\n\n---\n\n');
  logger.info({ filePath, textLength: text.length }, 'PDF Vision OCR complete');
  return text;
}

/**
 * Main PDF extraction flow with cascading strategy.
 */
export async function extractPdf(filePath: string): Promise<string> {
  const settings = getIngestSettings();

  if (settings.pdfExtractor === 'vision') {
    return extractPdfVision(filePath);
  }

  if (settings.pdfExtractor === 'pdfjs') {
    const { text } = await extractPdfText(filePath);
    return text;
  }

  // Auto mode: try pdfjs first, fallback to vision if quality is poor
  const { text, quality } = await extractPdfText(filePath);
  if (quality === 'good') {
    return text;
  }

  logger.info({ filePath }, 'PDF text quality poor, falling back to Vision OCR');
  return extractPdfVision(filePath);
}

// ---- DOCX Extractor ----

/**
 * Extract text from DOCX using mammoth.
 */
export async function extractDocx(filePath: string): Promise<string> {
  const mammoth = await import('mammoth');
  const buffer = fs.readFileSync(filePath);
  const result = await mammoth.extractRawText({ buffer });

  logger.info({ filePath, textLength: result.value.length }, 'DOCX text extracted');
  return result.value;
}

// ---- Spreadsheet Extractor ----

/**
 * Extract text from XLSX/CSV using xlsx, converting each sheet to markdown table.
 */
export async function extractSpreadsheet(filePath: string): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(fs.readFileSync(filePath));
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;

    parts.push(`## ${sheetName}\n`);

    const jsonData = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 });
    if (jsonData.length === 0) continue;

    const headers = (jsonData[0] || []).map((h) => String(h ?? ''));
    const separator = headers.map(() => '---');

    parts.push(`| ${headers.join(' | ')} |`);
    parts.push(`| ${separator.join(' | ')} |`);

    for (let i = 1; i < jsonData.length; i++) {
      const row = (jsonData[i] || []).map((c) => String(c ?? ''));
      // Pad row to match headers length
      while (row.length < headers.length) row.push('');
      parts.push(`| ${row.join(' | ')} |`);
    }

    parts.push('');
  }

  const text = parts.join('\n');
  logger.info({ filePath, textLength: text.length, sheets: workbook.SheetNames.length }, 'Spreadsheet extracted');
  return text;
}

// ---- Plain text extractors ----

/**
 * Read markdown or text files directly.
 */
export function extractPlainText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// ---- Image Extractor ----

/**
 * Extract content from an image using Claude Vision.
 * Supports .png, .jpg, .jpeg, .webp
 */
export async function extractImage(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
  };

  const mimeType = mimeMap[ext];
  if (!mimeType) {
    throw new Error(`Unsupported image format: ${ext}. Supported: .png, .jpg, .jpeg, .webp`);
  }

  const imageBase64 = fs.readFileSync(filePath).toString('base64');

  const text = await callClaudeVision(
    imageBase64,
    mimeType,
    'Extract all text and meaningful content from this image. Include any text, labels, data, diagrams, or visual information. Output as structured text/markdown.',
  );

  logger.info({ filePath, textLength: text.length }, 'Image content extracted via Vision');
  return text;
}

// ---- Audio/Video Extractors ----

/**
 * Check if ffmpeg is available on the system.
 */
export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    await execAsync(cmd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Transcribe audio using the configured STT provider (whisper via OpenAI or ElevenLabs).
 * Rejects audio longer than 60 minutes.
 */
export async function extractAudio(filePath: string): Promise<string> {
  // Check duration via ffprobe
  const hasFfmpeg = await checkFfmpegAvailable();
  if (hasFfmpeg) {
    try {
      const { stdout } = await execAsync(
        `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
      );
      const durationSec = parseFloat(stdout.trim());
      if (durationSec > MAX_AUDIO_MINUTES * 60) {
        throw new Error(`Audio too long: ${Math.round(durationSec / 60)} minutes (max ${MAX_AUDIO_MINUTES} minutes)`);
      }
    } catch (err) {
      // If ffprobe fails, still try to transcribe
      if (err instanceof Error && err.message.includes('Audio too long')) throw err;
      logger.warn({ err }, 'ffprobe duration check failed, continuing');
    }
  }

  const settings = getIngestSettings();

  if (settings.sttProvider === 'elevenlabs') {
    return transcribeWithElevenLabs(filePath);
  }

  return transcribeWithWhisper(filePath);
}

async function transcribeWithWhisper(filePath: string): Promise<string> {
  const { getSecret } = await import('./secrets-vault');
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY not configured for Whisper STT');

  const audioBuffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
  };
  const mimeType = mimeMap[ext] || 'audio/mpeg';
  const blob = new Blob([audioBuffer], { type: mimeType });

  const formData = new FormData();
  formData.append('file', blob, path.basename(filePath));
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Whisper STT failed: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as { text?: string };
  logger.info({ filePath, textLength: result.text?.length }, 'Whisper transcription complete');
  return result.text || '';
}

async function transcribeWithElevenLabs(filePath: string): Promise<string> {
  const { getSecret } = await import('./secrets-vault');
  const apiKey = await getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not configured for ElevenLabs STT');

  const audioBuffer = fs.readFileSync(filePath);
  const blob = new Blob([audioBuffer], { type: 'audio/mpeg' });

  const formData = new FormData();
  formData.append('file', blob, path.basename(filePath));
  formData.append('model_id', 'scribe_v1');

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs STT failed: ${response.status} ${errorText}`);
  }

  const result = (await response.json()) as { text?: string };
  logger.info({ filePath, textLength: result.text?.length }, 'ElevenLabs transcription complete');
  return result.text || '';
}

/**
 * Extract audio from a video file using ffmpeg, then transcribe.
 * Cleans up temporary WAV file even on error.
 */
export async function extractVideo(filePath: string): Promise<string> {
  const hasFfmpeg = await checkFfmpegAvailable();
  if (!hasFfmpeg) {
    throw new Error('ffmpeg is not installed. Video extraction requires ffmpeg.');
  }

  const tmpWav = path.join(
    getVaultRoot(),
    '.tmp',
    `video-audio-${Date.now()}.wav`,
  );
  fs.mkdirSync(path.dirname(tmpWav), { recursive: true });

  try {
    // Extract audio track as WAV
    await execAsync(`ffmpeg -i "${filePath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${tmpWav}" -y`, {
      timeout: 300000, // 5 minute timeout
    });

    // Transcribe the extracted audio
    return await extractAudio(tmpWav);
  } finally {
    // Always clean up temp file
    try {
      if (fs.existsSync(tmpWav)) {
        fs.unlinkSync(tmpWav);
      }
    } catch (cleanupErr) {
      logger.warn({ err: cleanupErr, tmpWav }, 'Failed to clean up temp audio file');
    }
  }
}

// ---- URL Extractors (3-level cascade) ----

/**
 * Level 1: Light extraction using fetch + jsdom + Readability + turndown.
 * Timeout: 10s
 */
export async function extractUrlLight(url: string): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LionClaw/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.content) {
      return '';
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    const markdown = turndown.turndown(article.content);

    logger.info({ url, textLength: markdown.length }, 'URL extracted via light fetch');
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Level 2: Use Electron BrowserWindow to render SPAs.
 * Waits 3s for JS rendering.
 */
export async function extractUrlElectron(url: string): Promise<string> {
  const { JSDOM } = await import('jsdom');
  const { Readability } = await import('@mozilla/readability');
  const TurndownService = (await import('turndown')).default;

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  try {
    await win.loadURL(url);

    // Wait 3s for JS rendering
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const html = await win.webContents.executeJavaScript('document.documentElement.outerHTML');

    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();

    if (!article || !article.content) {
      return '';
    }

    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
    });
    const markdown = turndown.turndown(article.content);

    logger.info({ url, textLength: markdown.length }, 'URL extracted via Electron BrowserWindow');
    return markdown;
  } finally {
    win.destroy();
  }
}

/**
 * Level 3: Use Jina Reader API for extraction.
 * Timeout: 15s
 */
export async function extractUrlJina(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: {
        Accept: 'text/markdown',
        'User-Agent': 'Mozilla/5.0 (compatible; LionClaw/1.0)',
      },
    });

    if (!response.ok) {
      throw new Error(`Jina API returned ${response.status}`);
    }

    const markdown = await response.text();
    logger.info({ url, textLength: markdown.length }, 'URL extracted via Jina Reader');
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Main URL extraction with 3-level cascade.
 * Validates SSRF before any fetch.
 */
export async function extractUrl(url: string): Promise<string> {
  // SSRF protection
  const safety = await validateUrlSafety(url);
  if (!safety.safe) {
    throw new Error(`URL blocked (SSRF): ${safety.error}`);
  }

  const settings = getIngestSettings();
  const maxLevel = settings.urlLevel;

  // Level 1: Light fetch
  try {
    const text = await extractUrlLight(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 1 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 1 extraction failed');
  }

  if (maxLevel < 2) {
    return '';
  }

  // Level 2: Electron BrowserWindow
  try {
    const text = await extractUrlElectron(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 2 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 2 extraction failed');
  }

  if (maxLevel < 3) {
    return '';
  }

  // Level 3: Jina Reader
  try {
    const text = await extractUrlJina(url);
    if (text.length >= URL_MIN_CONTENT) return text;
    logger.info({ url, textLength: text.length }, 'Level 3 extraction insufficient');
  } catch (err) {
    logger.warn({ url, err }, 'Level 3 extraction failed');
  }

  return '';
}

// ---- Chunking ----

/**
 * Check if a line is a markdown table row.
 */
function isTableRow(line: string): boolean {
  return /^\|.*\|$/.test(line.trim());
}

/**
 * Check if a line is a markdown heading.
 */
function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/**
 * Split text into structural chunks respecting headings, tables, and paragraphs.
 * Never cuts in the middle of a markdown table.
 * Max chunk size: 25000 chars. Overlap: 10%.
 */
export function chunkText(text: string): string[] {
  if (text.length <= CHUNK_SIZE) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks: string[] = [];
  let currentChunk: string[] = [];
  let currentLength = 0;

  // Track if we're inside a table
  let insideTable = false;
  let tableBuffer: string[] = [];

  function flushChunk() {
    if (currentChunk.length === 0) return;
    chunks.push(currentChunk.join('\n'));
    currentChunk = [];
    currentLength = 0;
  }

  function addOverlap() {
    if (chunks.length === 0) return;
    const lastChunk = chunks[chunks.length - 1];
    const overlapSize = Math.floor(lastChunk.length * CHUNK_OVERLAP_RATIO);
    const overlapText = lastChunk.slice(-overlapSize);

    // Find a clean break point (newline) within the overlap
    const newlineIdx = overlapText.indexOf('\n');
    const cleanOverlap = newlineIdx >= 0 ? overlapText.slice(newlineIdx + 1) : overlapText;

    if (cleanOverlap.length > 0) {
      currentChunk.push(cleanOverlap);
      currentLength += cleanOverlap.length;
    }
  }

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for newline

    // Handle table tracking
    if (isTableRow(line)) {
      if (!insideTable) {
        insideTable = true;
        tableBuffer = [];
      }
      tableBuffer.push(line);
      continue;
    } else if (insideTable) {
      // Table just ended, flush it as a block
      insideTable = false;
      const tableText = tableBuffer.join('\n');
      const tableLen = tableText.length + 1;

      // If adding the table would exceed chunk size, start a new chunk
      if (currentLength + tableLen > CHUNK_SIZE && currentChunk.length > 0) {
        flushChunk();
        addOverlap();
      }

      currentChunk.push(tableText);
      currentLength += tableLen;
      tableBuffer = [];
    }

    // Check if we need to split at a heading boundary
    if (isHeading(line) && currentLength + lineLen > CHUNK_SIZE && currentChunk.length > 0) {
      flushChunk();
      addOverlap();
    }

    // Check if line would exceed chunk size
    if (currentLength + lineLen > CHUNK_SIZE) {
      // Try to split at paragraph boundary (empty line)
      if (line.trim() === '' && currentChunk.length > 0) {
        flushChunk();
        addOverlap();
        continue;
      }

      // If current chunk is non-empty, flush it
      if (currentChunk.length > 0) {
        flushChunk();
        addOverlap();
      }
    }

    currentChunk.push(line);
    currentLength += lineLen;
  }

  // Handle any remaining table buffer
  if (tableBuffer.length > 0) {
    const tableText = tableBuffer.join('\n');
    currentChunk.push(tableText);
  }

  // Flush remaining content
  if (currentChunk.length > 0) {
    flushChunk();
  }

  return chunks;
}

// ---- Cost Estimation ----

/**
 * Estimate token count from character count.
 * Rough approximation: ~4 chars per token for English, ~3 for mixed content.
 */
function estimateTokens(charCount: number): number {
  return Math.ceil(charCount / 3.5);
}

/**
 * Calculate estimated cost in USD based on input tokens and number of chunks.
 */
export function estimateCost(totalInputTokens: number, nChunks: number): number {
  const inputCost = totalInputTokens * CLAUDE_INPUT_PRICE_PER_TOKEN;
  const outputCost = nChunks * ESTIMATED_OUTPUT_TOKENS_PER_CHUNK * CLAUDE_OUTPUT_PRICE_PER_TOKEN;
  return Math.round((inputCost + outputCost) * 10000) / 10000; // round to 4 decimal places
}

/**
 * Estimate the cost and chunking for ingesting a text.
 */
export function estimateIngest(text: string): IngestEstimate {
  const allChunks = chunkText(text);
  const originalChunkCount = allChunks.length;
  const truncated = originalChunkCount > MAX_CHUNKS_PER_JOB;
  const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
  const totalChunks = effectiveChunks.length;

  const totalChars = effectiveChunks.reduce((sum, c) => sum + c.length, 0);
  const estimatedTokens = estimateTokens(totalChars);
  const estimatedCostUsd = estimateCost(estimatedTokens, totalChunks);
  const requiresConfirmation = totalChunks > 5;

  return {
    totalChunks,
    estimatedTokens,
    estimatedCostUsd,
    requiresConfirmation,
    truncated,
    originalChunkCount,
  };
}

/**
 * Estimate ingest cost for a file without actually processing it.
 */
export async function estimateIngestFile(filePath: string): Promise<IngestEstimate> {
  const text = await extractByExtension(filePath);
  return estimateIngest(text);
}

// ---- AI Processing ----

const INGEST_PROMPT = `You are a knowledge extraction system. Analyze the following content and produce vault operations to populate a persistent knowledge graph.

SOURCE_NAME: {{SOURCE_NAME}}
SOURCE_TYPE: {{SOURCE_TYPE}}

CONTENT:
{{CONTENT}}

EXISTING NOTES (avoid duplicating these):
{{EXISTING_NOTES}}

RULES:
- Extract SIGNIFICANT knowledge: entities (people, tools, services), decisions, projects, meetings, references
- Each note must be self-contained with enough context to be useful standalone
- Use [[wiki-links]] to connect related notes (e.g. "Related to [[project-name]]")
- Path format: {type}/{slug}.md where type is one of: entities, meetings, decisions, projects, references
- Slug must be lowercase, a-z 0-9 hyphens only, max 50 chars
- For updates to existing notes, use action "update" with append=true to add new information
- IGNORE trivial or ephemeral information

Respond with a JSON array of vault operations. Each operation:
{
  "action": "create" or "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Human readable title",
  "tags": ["tag1", "tag2"],
  "content": "Markdown content with [[wiki-links]]",
  "append": true  // only for updates
}

If no significant information found, return an empty array: []

CRITICAL: Output ONLY valid JSON array, no markdown fences, no explanation.`;

const CHUNK_TIMEOUT_MS = 180000;
const MAX_RETRIES = 3;

// ---- Job State ----

let currentJobId: string | null = null;
let cancelledJobs = new Set<string>();

function getUploadsDir(): string {
  const dir = path.join(getVaultRoot(), '..', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function emitProgress(job: IngestJob): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0 && !wins[0].isDestroyed()) {
    wins[0].webContents.send('mgraph:ingest-progress', job);
  }
}

function emitUpdated(): void {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0 && !wins[0].isDestroyed()) {
    wins[0].webContents.send('mgraph:updated');
  }
}

/**
 * Extract text from a file based on its extension.
 */
async function extractByExtension(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.pdf': return extractPdf(filePath);
    case '.docx': return extractDocx(filePath);
    case '.xlsx':
    case '.csv': return extractSpreadsheet(filePath);
    case '.md':
    case '.txt':
    case '.json':
    case '.yaml':
    case '.yml': return extractPlainText(filePath);
    case '.png':
    case '.jpg':
    case '.jpeg':
    case '.webp': return extractImage(filePath);
    case '.mp3':
    case '.wav':
    case '.ogg':
    case '.webm':
    case '.m4a':
    case '.flac': return extractAudio(filePath);
    case '.mp4':
    case '.mov':
    case '.avi':
    case '.mkv': return extractVideo(filePath);
    default:
      // Try as plain text
      return extractPlainText(filePath);
  }
}

/**
 * Compute SHA-256 hash of a file.
 */
function computeFileHash(filePath: string): string {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Call Claude API for ingest chunk processing with timeout.
 */
async function callClaudeForIngest(prompt: string): Promise<VaultOperation[]> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { getApiKey } = await import('./secrets-vault');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const settings = getIngestSettings();
  const client = new Anthropic({ apiKey });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);

  try {
    const response = await client.messages.create({
      model: settings.extractionModel,
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: controller.signal });

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => ('text' in b ? (b as { text: string }).text : ''))
      .join('');

    // Parse JSON response
    let cleaned = text.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Response is not a JSON array');
    return parsed as VaultOperation[];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Process content chunks sequentially through AI to generate vault operations.
 */
async function processContent(
  chunks: string[],
  sourceName: string,
  sourceType: string,
  jobId: string,
  startChunk: number = 0,
): Promise<void> {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  let notesCreated = job.notesCreated;
  let notesUpdated = job.notesUpdated;
  const createdNotePaths: string[] = [...(job.createdNotePaths || [])];

  for (let i = startChunk; i < chunks.length; i++) {
    // Check cancellation
    if (cancelledJobs.has(jobId)) {
      cancelledJobs.delete(jobId);
      updateIngestJob(jobId, {
        status: 'partial',
        processedChunks: i,
        lastProcessedChunk: i - 1,
        notesCreated,
        notesUpdated,
        createdNotePaths,
      });
      logger.info({ jobId, chunk: i }, 'Ingest cancelled');
      return;
    }

    const chunk = chunks[i];

    // Build existing notes list including notes created by previous chunks in this job
    const existingNotes = getExistingVaultFilesList();

    const prompt = INGEST_PROMPT
      .replace('{{SOURCE_NAME}}', sourceName)
      .replace('{{SOURCE_TYPE}}', sourceType)
      .replace('{{CONTENT}}', chunk.substring(0, 50000))
      .replace('{{EXISTING_NOTES}}', existingNotes || '(none)');

    let operations: VaultOperation[] = [];
    let retries = 0;

    while (retries <= MAX_RETRIES) {
      try {
        operations = await callClaudeForIngest(prompt);
        break;
      } catch (err) {
        retries++;
        if (retries > MAX_RETRIES) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error({ jobId, chunk: i, error: errMsg }, 'Chunk processing failed after retries');

          // Mark as partial if we have processed some chunks
          if (i > startChunk) {
            updateIngestJob(jobId, {
              status: 'partial',
              processedChunks: i,
              lastProcessedChunk: i - 1,
              notesCreated,
              notesUpdated,
              error: `Chunk ${i} failed: ${errMsg}`,
              createdNotePaths,
            });
            const partialJob = getIngestJob(jobId);
            if (partialJob) emitProgress(partialJob);
            return;
          }

          // No chunks processed at all
          updateIngestJob(jobId, {
            status: 'failed',
            error: `Chunk ${i} failed: ${errMsg}`,
            completedAt: new Date().toISOString(),
          });
          const failedJob = getIngestJob(jobId);
          if (failedJob) emitProgress(failedJob);
          return;
        }
        logger.warn({ jobId, chunk: i, retry: retries }, 'Chunk failed, retrying');
      }
    }

    // Execute vault operations
    for (const op of operations) {
      if (op.action === 'update') {
        snapshotBeforeUpdate(op.path);
      }

      // If creating and file exists, switch to update with append
      const fullPath = path.join(getVaultRoot(), op.path);
      if (op.action === 'create' && fs.existsSync(fullPath)) {
        op.action = 'update';
        op.append = true;
      }

      const result = executeVaultOperation(op);
      if (result.success) {
        if (op.action === 'create') {
          notesCreated++;
          createdNotePaths.push(op.path);
        } else {
          notesUpdated++;
        }
        appendVaultLog(`[${new Date().toISOString()}] INGEST ${op.action.toUpperCase()} ${op.path} "${op.title}" (job:${jobId})`);
      } else {
        logger.warn({ jobId, op: op.path, error: result.error }, 'Vault operation failed');
      }
    }

    // Update job progress
    updateIngestJob(jobId, {
      processedChunks: i + 1,
      lastProcessedChunk: i,
      notesCreated,
      notesUpdated,
      createdNotePaths,
    });

    const updatedJob = getIngestJob(jobId);
    if (updatedJob) emitProgress(updatedJob);
  }

  // All chunks done
  regenerateVaultIndex();
  updateVaultHot();

  updateIngestJob(jobId, {
    status: 'completed',
    processedChunks: chunks.length,
    lastProcessedChunk: chunks.length - 1,
    notesCreated,
    notesUpdated,
    completedAt: new Date().toISOString(),
    createdNotePaths,
  });

  emitUpdated();

  const doneJob = getIngestJob(jobId);
  if (doneJob) emitProgress(doneJob);

  logger.info({ jobId, notesCreated, notesUpdated }, 'Ingest job completed');
}

// ---- Job Lifecycle ----

/**
 * Ingest a file. Copies to uploads/, computes hash, checks duplicates, extracts, chunks, processes.
 */
export async function ingestFile(filePath: string, fileName: string): Promise<IngestJob> {
  const jobId = crypto.randomUUID();

  // Copy to uploads
  const uploadsDir = getUploadsDir();
  const uniqueName = `${Date.now()}-${fileName}`;
  const uploadPath = path.join(uploadsDir, uniqueName);
  fs.copyFileSync(filePath, uploadPath);

  // Compute hash
  const fileHash = computeFileHash(filePath);

  // Check duplicate
  const existingJob = getIngestJobByHash(fileHash);
  const duplicateWarning = existingJob
    ? `Duplicate detected: file was previously ingested (job ${existingJob.id}, ${existingJob.completedAt})`
    : undefined;

  insertIngestJob({
    id: jobId,
    fileName,
    sourceType: path.extname(fileName).replace('.', '') || 'file',
    originalPath: uploadPath,
    fileHash,
  });

  if (duplicateWarning) {
    logger.warn({ jobId, fileHash }, duplicateWarning);
  }

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  // Start processing async
  currentJobId = jobId;
  processFileAsync(jobId, uploadPath, fileName).catch((err) => {
    logger.error({ jobId, err }, 'ingestFile processing failed');
  }).finally(() => {
    if (currentJobId === jobId) currentJobId = null;
  });

  return job;
}

async function processFileAsync(jobId: string, filePath: string, fileName: string): Promise<void> {
  try {
    // Extract text
    updateIngestJob(jobId, { status: 'extracting' });
    const text = await extractByExtension(filePath);

    if (!text || text.trim().length === 0) {
      updateIngestJob(jobId, {
        status: 'failed',
        error: 'No text extracted from file',
        completedAt: new Date().toISOString(),
      });
      const failedJob = getIngestJob(jobId);
      if (failedJob) emitProgress(failedJob);
      return;
    }

    // Chunk and estimate
    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
    });

    // Process
    updateIngestJob(jobId, { status: 'processing' });
    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(
      effectiveChunks,
      fileName,
      path.extname(fileName).replace('.', '') || 'file',
      jobId,
    );
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

/**
 * Ingest a URL. Extracts text via cascade, chunks, processes.
 */
export async function ingestUrl(url: string): Promise<IngestJob> {
  const jobId = crypto.randomUUID();

  insertIngestJob({
    id: jobId,
    fileName: url,
    sourceType: 'url',
    originalPath: url,
  });

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  currentJobId = jobId;
  processUrlAsync(jobId, url).catch((err) => {
    logger.error({ jobId, err }, 'ingestUrl processing failed');
  }).finally(() => {
    if (currentJobId === jobId) currentJobId = null;
  });

  return job;
}

async function processUrlAsync(jobId: string, url: string): Promise<void> {
  try {
    updateIngestJob(jobId, { status: 'extracting' });
    const text = await extractUrl(url);

    if (!text || text.trim().length === 0) {
      updateIngestJob(jobId, {
        status: 'failed',
        error: 'No content extracted from URL',
        completedAt: new Date().toISOString(),
      });
      const failedJob = getIngestJob(jobId);
      if (failedJob) emitProgress(failedJob);
      return;
    }

    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
      status: 'processing',
    });

    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(effectiveChunks, url, 'url', jobId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

/**
 * Ingest raw text directly.
 */
export async function ingestText(text: string, title?: string): Promise<IngestJob> {
  const jobId = crypto.randomUUID();
  const name = title || `text-${Date.now()}`;

  insertIngestJob({
    id: jobId,
    fileName: name,
    sourceType: 'text',
  });

  let job = getIngestJob(jobId)!;
  emitProgress(job);

  currentJobId = jobId;
  processTextAsync(jobId, text, name).catch((err) => {
    logger.error({ jobId, err }, 'ingestText processing failed');
  }).finally(() => {
    if (currentJobId === jobId) currentJobId = null;
  });

  return job;
}

async function processTextAsync(jobId: string, text: string, name: string): Promise<void> {
  try {
    updateIngestJob(jobId, { status: 'estimating' });
    const allChunks = chunkText(text);
    const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
    const estimate = estimateIngest(text);

    updateIngestJob(jobId, {
      totalChunks: effectiveChunks.length,
      estimatedCostUsd: estimate.estimatedCostUsd,
      status: 'processing',
    });

    let job = getIngestJob(jobId);
    if (job) emitProgress(job);

    await processContent(effectiveChunks, name, 'text', jobId);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    updateIngestJob(jobId, {
      status: 'failed',
      error: errMsg,
      completedAt: new Date().toISOString(),
    });
    const failedJob = getIngestJob(jobId);
    if (failedJob) emitProgress(failedJob);
  }
}

/**
 * Resume a partial/failed job from lastProcessedChunk + 1.
 */
export async function resumeIngestJob(jobId: string): Promise<IngestJob> {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.status !== 'partial' && job.status !== 'failed') {
    throw new Error(`Job ${jobId} cannot be resumed (status: ${job.status})`);
  }

  // Re-extract text to get chunks
  let text: string;
  if (job.sourceType === 'url') {
    text = await extractUrl(job.originalPath || job.fileName);
  } else if (job.sourceType === 'text') {
    throw new Error('Text jobs cannot be resumed - please re-ingest the text');
  } else {
    if (!job.originalPath || !fs.existsSync(job.originalPath)) {
      throw new Error('Original file not found for resume');
    }
    text = await extractByExtension(job.originalPath);
  }

  const allChunks = chunkText(text);
  const effectiveChunks = allChunks.slice(0, MAX_CHUNKS_PER_JOB);
  const startFrom = job.lastProcessedChunk + 1;

  updateIngestJob(jobId, {
    status: 'processing',
    error: undefined,
  });

  const updatedJob = getIngestJob(jobId)!;
  emitProgress(updatedJob);

  currentJobId = jobId;
  processContent(
    effectiveChunks,
    job.fileName,
    job.sourceType,
    jobId,
    startFrom,
  ).catch((err) => {
    logger.error({ jobId, err }, 'resumeIngestJob processing failed');
  }).finally(() => {
    if (currentJobId === jobId) currentJobId = null;
  });

  return updatedJob;
}

/**
 * Cancel an active ingest job.
 */
export function cancelIngest(jobId: string): void {
  cancelledJobs.add(jobId);
  logger.info({ jobId }, 'Ingest cancel requested');
}

/**
 * Discard a partial job: remove created notes and mark as failed.
 */
export function discardPartialJob(jobId: string): void {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  // Remove notes created by this job
  if (job.createdNotePaths && job.createdNotePaths.length > 0) {
    for (const notePath of job.createdNotePaths) {
      try {
        deleteVaultNote(notePath, { force: true });
      } catch (err) {
        logger.warn({ jobId, notePath, err }, 'Failed to delete note during discard');
      }
    }

    regenerateVaultIndex();
    updateVaultHot();
    emitUpdated();
  }

  updateIngestJob(jobId, {
    status: 'failed',
    error: 'Discarded by user',
    completedAt: new Date().toISOString(),
    createdNotePaths: [],
  });

  logger.info({ jobId, removedNotes: job.createdNotePaths?.length || 0 }, 'Partial job discarded');
}

/**
 * Accept a partial job as completed, keeping created notes.
 */
export function acceptPartialJob(jobId: string): void {
  const job = getIngestJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);

  updateIngestJob(jobId, {
    status: 'completed',
    completedAt: new Date().toISOString(),
  });

  logger.info({ jobId, notesKept: job.createdNotePaths?.length || 0 }, 'Partial job accepted');
}

/**
 * Get ingest history.
 */
export function getIngestHistory(): IngestJob[] {
  return getAllIngestJobs();
}

// ---- Uploads cleanup ----

/**
 * Remove upload files for completed jobs older than 30 days.
 * Jobs with 'partial' or 'failed' status keep their files.
 */
export function cleanOldUploads(): { removed: number } {
  const uploadsDir = path.join(getVaultRoot(), '..', 'uploads');
  if (!fs.existsSync(uploadsDir)) return { removed: 0 };

  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let removed = 0;

  const allJobs = getAllIngestJobs();
  const completedJobPaths = new Set<string>();

  for (const job of allJobs) {
    if (job.status === 'completed' && job.completedAt) {
      const completedTime = new Date(job.completedAt).getTime();
      if (completedTime < thirtyDaysAgo && job.originalPath) {
        completedJobPaths.add(job.originalPath);
      }
    }
  }

  for (const uploadPath of completedJobPaths) {
    try {
      if (fs.existsSync(uploadPath)) {
        fs.unlinkSync(uploadPath);
        removed++;
      }
    } catch (err) {
      logger.warn({ uploadPath, err }, 'Failed to remove old upload');
    }
  }

  // Also clean old snapshots
  cleanOldSnapshots();

  logger.info({ removed }, 'Old uploads cleaned');
  return { removed };
}

// ---- Ingest Queue Watcher ----

const INGEST_QUEUE_DIR = path.join(getVaultRoot(), '.ingest-queue');

/**
 * Process a single ingest job from the .ingest-queue directory.
 * Reads the JSON file, routes to the appropriate ingest function, then deletes the file.
 */
export async function processIngestJob(jobFilePath: string): Promise<void> {
  try {
    if (!fs.existsSync(jobFilePath)) return;

    const raw = fs.readFileSync(jobFilePath, 'utf-8');
    const job = JSON.parse(raw) as { type: 'text' | 'file' | 'url'; content: string; title?: string | null; timestamp: string };

    logger.info({ jobFilePath, type: job.type }, 'Processing ingest queue job');

    // Remove job file first to avoid double-processing
    fs.unlinkSync(jobFilePath);

    if (job.type === 'text') {
      await ingestText(job.content, job.title || undefined);
    } else if (job.type === 'file') {
      const fileName = job.title || path.basename(job.content);
      await ingestFile(job.content, fileName);
    } else if (job.type === 'url') {
      await ingestUrl(job.content);
    } else {
      logger.warn({ type: (job as { type: string }).type }, 'Unknown ingest job type, skipping');
    }
  } catch (err) {
    logger.error({ jobFilePath, err }, 'Failed to process ingest queue job');
  }
}

let ingestQueueWatcher: fs.FSWatcher | null = null;

/**
 * Start watching the .ingest-queue directory for new job files.
 * Uses fs.watch() and processes each .json file as it appears.
 */
export function startIngestQueueWatcher(): void {
  fs.mkdirSync(INGEST_QUEUE_DIR, { recursive: true });

  // Recover stuck jobs from previous session (processing/extracting/estimating → failed)
  const allJobs = getAllIngestJobs();
  const stuckStatuses = ['processing', 'extracting', 'estimating'];
  const stuckJobs = allJobs.filter((j) => stuckStatuses.includes(j.status));
  if (stuckJobs.length > 0) {
    for (const job of stuckJobs) {
      updateIngestJob(job.id, {
        status: 'failed',
        error: 'Processo interrompido por reinicio do app',
      });
      logger.warn({ jobId: job.id, fileName: job.fileName, previousStatus: job.status }, 'Recovered stuck ingest job on boot');
    }
    logger.info({ count: stuckJobs.length }, 'Marked stuck ingest jobs as failed on boot');
  }

  // Process any jobs that were queued while the app was closed
  const existingFiles = fs.readdirSync(INGEST_QUEUE_DIR).filter(f => f.endsWith('.json'));
  for (const file of existingFiles) {
    processIngestJob(path.join(INGEST_QUEUE_DIR, file)).catch((err) => {
      logger.error({ file, err }, 'Failed to process pre-existing ingest job');
    });
  }

  ingestQueueWatcher = fs.watch(INGEST_QUEUE_DIR, (_event, filename) => {
    if (!filename || !filename.endsWith('.json')) return;
    const jobFilePath = path.join(INGEST_QUEUE_DIR, filename);
    // Small delay to ensure the file is fully written before reading
    setTimeout(() => {
      processIngestJob(jobFilePath).catch((err) => {
        logger.error({ jobFilePath, err }, 'Ingest queue watcher: job processing failed');
      });
    }, 200);
  });

  ingestQueueWatcher.on('error', (err) => {
    logger.error({ err }, 'Ingest queue watcher error');
  });

  logger.info({ dir: INGEST_QUEUE_DIR }, 'Ingest queue watcher started');
}

/**
 * Stop the .ingest-queue watcher. Call on app quit.
 */
export function stopIngestQueueWatcher(): void {
  if (ingestQueueWatcher) {
    ingestQueueWatcher.close();
    ingestQueueWatcher = null;
    logger.info('Ingest queue watcher stopped');
  }
}
