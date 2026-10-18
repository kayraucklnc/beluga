import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { type Plugin, defineConfig } from 'vite';

const repo = path.resolve(__dirname, '../..');

/**
 * In the browser (development, screenshots) there's no Tauri to ask where the daemon is:
 * the dev server reads ~/.klaud/daemon.json and hands the web view its port and token.
 * Only on localhost, only while developing.
 */
function daemonEndpoint(): Plugin {
  return {
    name: 'klaud-daemon-endpoint',
    configureServer(server) {
      server.middlewares.use('/__klaud/endpoint', (_req, res) => {
        const home = process.env.KLAUD_HOME ?? path.join(os.homedir(), '.klaud');
        try {
          const info = JSON.parse(readFileSync(path.join(home, 'daemon.json'), 'utf8')) as { port: number; token: string; version: string };
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ url: `ws://127.0.0.1:${info.port}`, token: info.token, version: info.version }));
        } catch {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'klaud is not running. Start it with: klaud daemon --keep-alive' }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), daemonEndpoint()],
  resolve: { alias: { '@klaud': path.join(repo, 'src') } },
  clearScreen: false,
  server: { port: 1420, strictPort: true, fs: { allow: [repo] } },
  build: { target: 'safari16', outDir: 'dist', sourcemap: true },
});
