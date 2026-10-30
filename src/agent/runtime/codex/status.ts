import type { RuntimeStatus } from '../types.js';
import { type CodexConnect, findCodex, spawnAppServer } from './app-server.js';
import type { Model } from './protocol.js';
import { toCodexModelChoices } from './runner.js';

const STATUS_TIMEOUT_MS = 20_000;

export const CODEX_MISSING = 'Install the Codex app, or run npm i -g @openai/codex';
export const CODEX_SIGN_IN = 'Run codex login in Terminal, or sign in in the Codex app';

/**
 * Codex on this Mac (BLG-455): not installed, installed but not signed in, or ready with its
 * models. Asks a short-lived app-server (`account/read`, refreshing the login so an expired one
 * reads as signed out, then `model/list`); never signs in.
 */
export async function codexStatus(deps: { readonly connect?: CodexConnect; readonly bin?: string } = {}): Promise<RuntimeStatus> {
  const bin = deps.bin ?? (deps.connect ? undefined : findCodex());
  if (!deps.connect && !bin) return { state: 'missing', fix: CODEX_MISSING, models: [] };
  const conn = await (deps.connect ?? spawnAppServer)({ cwd: process.cwd(), ...(bin ? { bin } : {}) }).catch(() => undefined);
  if (!conn) return { state: 'missing', fix: CODEX_MISSING, models: [] };
  try {
    const account = await conn.rpc.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: true }, STATUS_TIMEOUT_MS);
    if (!account.account && account.requiresOpenaiAuth) return { state: 'signed_out', fix: CODEX_SIGN_IN, models: [] };
    const models = await conn.rpc.request<{ data: Model[] }>('model/list', {}, STATUS_TIMEOUT_MS);
    return { state: 'ready', models: toCodexModelChoices(models.data) };
  } catch {
    return { state: 'signed_out', fix: CODEX_SIGN_IN, models: [] };
  } finally {
    await conn.proc.kill();
  }
}
