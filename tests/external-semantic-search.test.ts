import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { modelDir, type RatelModules, semanticDir } from '../src/external/adapters/semantic-fetch.js';
import { openSemantic, semanticSearch } from '../src/external/adapters/semantic-search.js';
import type { ExternalToolDef } from '../src/external/adapters/mcp-tools.js';
import { withDiscovery } from '../src/external/adapters/tools/discover.js';
import type { Level } from '../src/external/domain/decide.js';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const TOOLS = [
  { name: 'sentinel_remove', description: 'Delete a sentinel.', inputSchema: { type: 'object' } },
  { name: 'task_note', description: 'Leave a note on a task.', inputSchema: { type: 'object' } },
];

/** Ratel's two modules, faked: what was embedded, and how each catalog was made. */
function fakeRatel(ranked: readonly string[] = ['sentinel_remove', 'task_note']) {
  const built: Array<{ output: string; embedding?: object; tools: readonly object[] }> = [];
  const catalogs: object[] = [];
  const modules: RatelModules = {
    experimentalBuildEmbeddingArtifact: vi.fn(async (options) => {
      built.push(options);
      writeFileSync(options.output, 'RAT1');
    }),
    ToolCatalog: class {
      constructor(options: object) {
        catalogs.push(options);
      }
      async register() {}
      async searchAsync() {
        return ranked.map((toolId) => ({ toolId }));
      }
    },
  };
  return { modules, built, catalogs, load: vi.fn(async () => modules) };
}

describe('the embedding file', () => {
  it('a start with the same tools makes no embedding call: it warms from the .rat1 file', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'semantic-search-'));
    const r = fakeRatel();
    await openSemantic(TOOLS, { home: dir, load: r.load });
    expect(r.built).toHaveLength(1);
    const file = readdirSync(semanticDir(dir)).find((f) => f.endsWith('.rat1'))!;
    expect(file).toMatch(/^tools-[0-9a-f]{16}\.rat1$/);
    expect(r.built[0]!.embedding).toEqual({ local: modelDir(dir), queryPrefix: expect.stringContaining('Represent this sentence') });

    const again = await openSemantic(TOOLS, { home: dir, load: r.load });
    expect(r.built).toHaveLength(1);
    expect(r.catalogs.at(-1)).toMatchObject({ method: 'semantic', experimentalEmbeddingArtifact: { path: path.join(semanticDir(dir), file), onMiss: 'embed' } });
    expect(await again.rank('get rid of that watcher')).toEqual(['sentinel_remove', 'task_note']);
  });

  it('a changed tool definition embeds again, into a new file, and the old one goes', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'semantic-search-'));
    const r = fakeRatel();
    await openSemantic(TOOLS, { home: dir, load: r.load });
    await openSemantic([{ ...TOOLS[0]!, description: 'Delete a sentinel and its runs.' }, TOOLS[1]!], { home: dir, load: r.load });
    expect(r.built).toHaveLength(2);
    expect(readdirSync(semanticDir(dir)).filter((f) => f.endsWith('.rat1'))).toHaveLength(1);
  });
});

describe('beluga_find with semantic ranking on', () => {
  const def = (name: ExternalToolDef['name'], description: string): ExternalToolDef => ({ name, description, inputSchema: { id: z.string().optional() }, resolve: () => ({ target: '', inScope: true }), run: () => ({}) });
  const others = [def('sentinel_remove', 'Delete a sentinel.'), def('task_note', 'Leave a note on a task.')];
  const grant = (level: Level) => ({ id: 'g', name: 'n', clientId: 'c', redirectHost: 'h', route: 'local', level, projects: 'all', chats: { dms: false, groups: false }, createdAt: 0, expiresAt: Date.now() + 60_000, lastSeen: 0 }) as never;
  const find = async (rank: Parameters<typeof withDiscovery>[2], query: string, level: Level = 'full') => {
    const tool = withDiscovery([], others, rank).find((t) => t.name === 'beluga_find')!;
    return ((await tool.run({ query }, grant(level))) as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
  };
  const ready = async (engine: { rank: (q: string) => Promise<readonly string[]> }) => {
    const search = semanticSearch({ tools: () => [], on: () => true, toast: () => undefined, open: async () => engine });
    search.follow();
    await vi.waitFor(() => expect(search.status().state).toBe('ready'));
    return search;
  };

  it('ranks by meaning once ready', async () => {
    const search = await ready({ rank: async () => ['sentinel_remove', 'task_note'] });
    expect(await find(search.rank, 'get rid of that watcher')).toEqual(['sentinel_remove', 'task_note']);
  });

  it('a level-denied tool never comes back', async () => {
    const search = await ready({ rank: async () => ['sentinel_remove', 'task_note'] });
    expect(await find(search.rank, 'get rid of that watcher', 'blocked')).toEqual([]);
  });

  it('an SDK failure falls back to BM25: at load, and at a search', async () => {
    const toasts: string[] = [];
    const broken = semanticSearch({ tools: () => [], on: () => true, toast: (text) => void toasts.push(text), open: async () => { throw new Error('addon failed to load'); } });
    broken.follow();
    await vi.waitFor(() => expect(broken.status().state).toBe('failed'));
    expect(await find(broken.rank, 'leave a note')).toEqual(['task_note']);
    expect(toasts.filter((t) => t.includes('addon failed to load'))).toHaveLength(1);
    const crashing = await ready({ rank: async () => { throw new Error('embedder crashed'); } });
    expect(await find(crashing.rank, 'leave a note')).toEqual(['task_note']);
  });
});

describe('turning it off', () => {
  it('removes the packages, the model and the embedding file, and goes back to BM25', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'semantic-search-'));
    let on = true;
    const remove = vi.fn(async () => rmSync(semanticDir(dir), { recursive: true, force: true }));
    const r = fakeRatel();
    const search = semanticSearch({ tools: () => TOOLS, on: () => on, toast: () => undefined, open: (tools) => openSemantic(tools, { home: dir, load: r.load }), remove });
    search.follow();
    await vi.waitFor(() => expect(search.status().state).toBe('ready'));
    expect(existsSync(semanticDir(dir))).toBe(true);
    on = false;
    search.follow();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(existsSync(semanticDir(dir))).toBe(false);
    expect(search.status().state).toBe('idle');
    expect(await search.rank('anything')).toBeUndefined();
  });

  it('a start with it off cleans what an earlier Beluga left', async () => {
    const remove = vi.fn(async () => undefined);
    semanticSearch({ tools: () => [], on: () => false, toast: () => undefined, open: async () => ({ rank: async () => [] }), fetched: () => true, remove }).follow();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('turned off while preparing: the late result is dropped, and what it wrote is removed', async () => {
    let on = true;
    let finish: () => void = () => undefined;
    const remove = vi.fn(async () => undefined);
    const search = semanticSearch({ tools: () => [], on: () => on, toast: () => undefined, open: () => new Promise((resolve) => (finish = () => resolve({ rank: async () => ['x'] }))), remove });
    search.follow();
    on = false;
    search.follow();
    finish();
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    expect(search.status().state).toBe('idle');
  });
});
