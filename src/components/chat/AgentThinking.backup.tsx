import React from 'react';

export function AgentThinking() {
  const themeColor = '#FF7A00';
  const themeGlow = '#FF7A0080';

  return (
    <div
      className="flex items-center gap-3"
      style={{
        '--agent-color': themeColor,
        '--agent-glow': themeGlow,
      } as React.CSSProperties}
    >
      <style>{`
        .agent-thinking-core { background-color: var(--agent-color); }
        .agent-thinking-border { border-color: var(--agent-color); }
        .agent-thinking-glow { box-shadow: 0 0 16px var(--agent-glow); }

        @keyframes orbit1 {
          0% { transform: rotateX(70deg) rotateY(-45deg) rotateZ(0deg); }
          100% { transform: rotateX(70deg) rotateY(-45deg) rotateZ(360deg); }
        }
        @keyframes orbit2 {
          0% { transform: rotateX(45deg) rotateY(60deg) rotateZ(0deg); }
          100% { transform: rotateX(45deg) rotateY(60deg) rotateZ(360deg); }
        }
        @keyframes orbit3 {
          0% { transform: rotateX(-60deg) rotateY(30deg) rotateZ(0deg); }
          100% { transform: rotateX(-60deg) rotateY(30deg) rotateZ(360deg); }
        }

        .orbit-ring-1 { animation: orbit1 1.5s linear infinite; }
        .orbit-ring-2 { animation: orbit2 2s linear infinite; }
        .orbit-ring-3 { animation: orbit3 2.5s linear infinite; }
      `}</style>

      <div className="relative w-10 h-10 flex items-center justify-center" style={{ perspective: '800px' }}>
        {/* Core */}
        <div className="absolute w-2.5 h-2.5 rounded-full agent-thinking-core agent-thinking-glow animate-pulse" />

        {/* Orbits */}
        <div className="absolute w-full h-full rounded-full border-t border-r border-transparent agent-thinking-border orbit-ring-1" />
        <div className="absolute w-7 h-7 rounded-full border-b border-l border-dashed border-transparent agent-thinking-border orbit-ring-2" />
        <div className="absolute w-8 h-8 rounded-full border border-dotted border-transparent agent-thinking-border orbit-ring-3" />
      </div>

      <span className="text-xs text-zinc-500">Pensando...</span>
    </div>
  );
}
