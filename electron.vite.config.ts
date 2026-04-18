import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      include: [
        '@anthropic-ai/claude-agent-sdk',
        '@anthropic-ai/sdk',
        'better-sqlite3',
        'keytar',
        'bcrypt',
      ],
    })],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/main/index.ts'),
        },
        external: [
          '@anthropic-ai/claude-agent-sdk',
          '@anthropic-ai/sdk',
        ],
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/types'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'electron/preload/index.ts'),
        },
      },
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'index.html'),
        },
      },
    },
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
  },
});
