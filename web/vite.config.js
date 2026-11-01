import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // Proxy target for /api and /socket.io. Override with VITE_API_URL when the API
  // is not on the default port; the client itself always calls same-origin paths.
  const target = env.VITE_API_URL || `http://localhost:${env.API_PORT || 4000}`;

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT || 5173),
      proxy: {
        '/api': { target, changeOrigin: true },
        '/socket.io': { target, ws: true, changeOrigin: true },
        '/healthz': { target, changeOrigin: true },
      },
    },
    build: { outDir: 'dist', sourcemap: false },
  };
});
