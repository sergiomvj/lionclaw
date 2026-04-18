import { useState, useRef, useCallback } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';

interface VoiceRecorderProps {
  onAudioReady: (audioBase64: string, transcription: string) => void;
  disabled?: boolean;
}

export function VoiceRecorder({ onAudioReady, disabled }: VoiceRecorderProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });

        setIsTranscribing(true);
        try {
          const buffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(buffer);
          let binary = '';
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          const base64 = btoa(binary);
          const text = await window.lionclaw.voice.transcribe(base64);
          onAudioReady(base64, text || '');
        } catch (err) {
          console.error('Transcription failed:', err);
        } finally {
          setIsTranscribing(false);
        }
      };

      mediaRecorder.start(250);
      setIsRecording(true);
    } catch (err) {
      console.error('Mic access denied:', err);
    }
  }, [onAudioReady]);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  if (isTranscribing) {
    return (
      <button disabled className="p-1.5 rounded-lg bg-zinc-800 text-amber-500">
        <Loader2 size={16} className="animate-spin" />
      </button>
    );
  }

  return (
    <button
      onClick={isRecording ? stopRecording : startRecording}
      disabled={disabled}
      className={`p-1.5 rounded-lg transition-colors ${
        isRecording
          ? 'bg-red-600 hover:bg-red-500 text-white animate-pulse'
          : 'bg-zinc-800 hover:bg-zinc-700 text-zinc-400 hover:text-amber-400'
      } disabled:opacity-30`}
      title={isRecording ? 'Parar gravacao' : 'Gravar audio'}
    >
      {isRecording ? <Square size={16} /> : <Mic size={16} />}
    </button>
  );
}
