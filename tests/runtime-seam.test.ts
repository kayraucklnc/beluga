import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { guardedBackend } from '../src/agent/runtime/guard.js';
import type { AgentBackend, AgentRunInput } from '../src/agent/types.js';
import type { RuntimeCapabilities } from '../src/agent/runtime/types.js';

const SRC = path.resolve(__dirname, '../src');
const CLAUDE_DIR = path.join(SRC, 'agent/runtime/claude') + path.sep;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : /\.tsx?$/.test(name) ? [full] : [];
  });
}

/** An import of the SDK or one of its sub-paths, static or dynamic (a re-export counts too). */
const SDK_IMPORT = /(?:from\s+|import\s*\(\s*|import\s+)['"]@anthropic-ai\/claude-agent-sdk(?:\/[^'"]*)?['"]/;

describe('the runtime seam', () => {
  it('keeps every Claude Agent SDK import under src/agent/runtime/claude/', () => {
    const outside = sources(SRC)
      .filter((file) => !file.startsWith(CLAUDE_DIR) && SDK_IMPORT.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(outside).toEqual([]);
  });

  it('registers Claude, gating every tool, as the default runtime', async () => {
    const { runtimeFor } = await import('../src/agent/runtime/registry.js');
    expect(runtimeFor()?.id).toBe('claude');
    expect(runtimeFor('claude')?.capabilities.canGateEveryTool).toBe(true);
    expect(runtimeFor('codex')).toBeUndefined();
  });
});

describe('guardedBackend', () => {
  const caps = (canGateEveryTool: boolean) => ({ canGateEveryTool }) as RuntimeCapabilities;
  const input = (extra: Partial<AgentRunInput> = {}) => ({ prompt: 'hi', ...extra }) as AgentRunInput;

  it('leaves a runtime that gates every tool as it is', () => {
    const backend: AgentBackend = { run: vi.fn(async () => 'ok') };
    expect(guardedBackend(backend, caps(true))).toBe(backend);
  });

  it('runs one that cannot gate sandboxed, keeping its other abilities', async () => {
    const run = vi.fn(async (_: AgentRunInput) => 'ok');
    const guarded = guardedBackend({ run, nameTask: async () => 'name' }, caps(false));
    expect(await guarded.run(input())).toBe('ok');
    expect(run.mock.calls[0]?.[0].sandbox).toBe(true);
    expect(await guarded.nameTask?.('x')).toBe('name');
  });

  it("refuses a friend's task and a guest on one that cannot gate", async () => {
    const run = vi.fn(async () => 'ok');
    const guarded = guardedBackend({ run }, caps(false));
    await expect(guarded.run(input({ vetTool: () => undefined }))).rejects.toThrow(/friends/);
    await expect(guarded.run(input({ guest: true }))).rejects.toThrow(/guests/);
    expect(run).not.toHaveBeenCalled();
  });
});
