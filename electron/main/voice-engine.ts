import { createLogger } from './logger';
import { getSecret } from './secrets-vault';
import { getSetting } from './db';

const logger = createLogger('voice-engine');

export async function transcribeAudio(
  audioBase64: string,
  format: 'webm' | 'ogg' | 'mp3' = 'webm',
): Promise<string> {
  const apiKey = await getSecret('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY nao configurada. Configure no Vault para usar transcricao de audio.');

  const mimeTypes = { webm: 'audio/webm', ogg: 'audio/ogg', mp3: 'audio/mpeg' };
  const audioBuffer = Buffer.from(audioBase64, 'base64');
  const blob = new Blob([audioBuffer], { type: mimeTypes[format] });

  const formData = new FormData();
  formData.append('file', blob, `recording.${format}`);
  formData.append('model', 'whisper-1');
  formData.append('language', 'pt');
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, errorText }, 'Whisper STT failed');
    throw new Error(`Whisper STT failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json() as { text?: string };
  logger.info({ textLength: result.text?.length }, 'Whisper transcription complete');
  return result.text || '';
}

export async function generateSpeech(
  text: string,
  voiceId?: string,
  outputFormat?: 'mp3' | 'opus',
): Promise<{ base64: string; format: 'mp3' | 'opus' }> {
  const apiKey = await getSecret('ELEVENLABS_API_KEY');
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY nao configurada. Configure no Vault.');

  const selectedVoice = voiceId || (getSetting('voice_id') as string) || 'Xb7hH8MSUJpSbSDYk0k2';
  const format = outputFormat || 'mp3';

  const formatParam = format === 'opus' ? 'opus_48000_64' : 'mp3_44100_128';

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoice}?output_format=${formatParam}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    logger.error({ status: response.status, errorText }, 'ElevenLabs TTS failed');
    throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return { base64: buffer.toString('base64'), format };
}
