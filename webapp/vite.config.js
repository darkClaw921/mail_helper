// Vite config для webapp/client.
// - root — webapp/client (index.html живёт там)
// - dev-сервер на :5173, прокси /api и /ws на http://localhost:3000 (Express)
// - Tailwind v4 через плагин @tailwindcss/vite (конфиг-файлов не нужно,
//   директива @import "tailwindcss" в src/style.css)

import { defineConfig, loadEnv } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = env.PORT || '3000';
  return {
  root: 'client',
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://localhost:${backendPort}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `ws://localhost:${backendPort}`,
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  };
});
