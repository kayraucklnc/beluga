import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Start klaud's demo (simulated friends and Claudes) as a daemon for the tests; stop it after. */
export default async function setup(): Promise<() => void> {
  const home = process.env.KLAUD_HOME!;
  const repo = path.resolve(import.meta.dirname, '../../..');
  const child = spawn('npx', ['tsx', 'src/cli.tsx', 'daemon', '--keep-alive', 'demo'], {
    cwd: repo,
    env: { ...process.env, KLAUD_HOME: home, KLAUD_DEMO_PACE: process.env.E2E_DEMO_PACE ?? '0.3', KLAUD_ALLOW_ORIGINS: `http://localhost:${process.env.E2E_PORT ?? 1421}` },
    stdio: 'ignore',
  });
  const info = path.join(home, 'daemon.json');
  for (let i = 0; i < 120 && !existsSync(info); i++) await new Promise((r) => setTimeout(r, 250));
  if (!existsSync(info)) throw new Error('The demo daemon did not start');
  // Let the pretend friends arrive.
  await new Promise((r) => setTimeout(r, 6000));
  return () => {
    try {
      process.kill((JSON.parse(readFileSync(info, 'utf8')) as { pid: number }).pid, 'SIGTERM');
    } catch {
      child.kill();
    }
  };
}
