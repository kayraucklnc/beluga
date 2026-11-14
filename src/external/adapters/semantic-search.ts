import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SearchableTool } from '../domain/tool-search.js';
import { BGE_SMALL, type FetchOptions, type FetchProgress, loadSemantic, modelDir, type RatelModules, SEMANTIC_VERSION, semanticDir } from './semantic-fetch.js';
import type { SemanticRanking } from './tools/discover.js';

/**
 * Semantic tool search (Settings › Experimental): beluga_find ranks by meaning, so "delete that watcher" finds
 * sentinel_remove. Off until the person turns it on. Turned on, it fetches and checks Ratel and its model
 * (semantic-fetch.ts), then reads the tools once. Until it is ready, or when anything fails, beluga_find ranks with
 * its built-in BM25, and a failure says so once.
 */

/** Ranks by meaning, once ready. */
export interface MeaningEngine {
  rank(query: string): Promise<readonly string[]>;
}

export type SemanticState = 'idle' | 'preparing' | 'ready' | 'failed';

export interface SemanticStatus {
  readonly state: SemanticState;
  /** While preparing: bytes fetched of the total. */
  readonly progress?: FetchProgress;
  /** When failed: why, in words. */
  readonly error?: string;
}

export interface SemanticSearchDeps {
  readonly tools: () => readonly SearchableTool[];
  /** Whether it is on now (the experiment in prefs). */
  readonly on: () => boolean;
  readonly toast: (text: string, level: 'info' | 'success' | 'warn' | 'error') => void;
  readonly open: (tools: readonly SearchableTool[], onProgress: (progress: FetchProgress) => void) => Promise<MeaningEngine>;
  /** Whether something was fetched: getting ready says so only when it was not, and a start with it off cleans it. */
  readonly fetched?: () => boolean;
  /** Turn off: deletes the packages, the model and the embedding file. */
  readonly remove?: () => Promise<void>;
  /** Each change of status, for the screens. */
  readonly onChange?: (status: SemanticStatus) => void;
}

export interface SemanticSearch {
  /** For withDiscovery: ranks by meaning when on and ready, else undefined (beluga_find uses BM25). */
  readonly rank: SemanticRanking;
  /** Call on each change of prefs: gets ready once it is turned on; after a failure, tries again only once turned off and on. */
  readonly follow: () => void;
  readonly status: () => SemanticStatus;
}

export function semanticSearch(deps: SemanticSearchDeps): SemanticSearch {
  let status: SemanticStatus = { state: 'idle' };
  let engine: MeaningEngine | undefined;
  // A turn off while preparing makes that preparation's result stale.
  let run = 0;
  let started = false;
  const set = (next: SemanticStatus): void => {
    status = next;
    deps.onChange?.(status);
  };
  const clean = (): void => {
    deps.remove?.().catch((err: unknown) => deps.toast(`Semantic tool search could not delete its files (${err instanceof Error ? err.message : String(err)}). Delete ~/.beluga/tool-search by hand.`, 'warn'));
  };
  const prepare = (): void => {
    const mine = ++run;
    const announce = !(deps.fetched?.() ?? false);
    set({ state: 'preparing' });
    if (announce) deps.toast('Getting semantic tool search ready: a one-time download of about 138 MB, then Beluga reads its tools once. This takes a minute or two.', 'info');
    deps
      .open(deps.tools(), (progress) => mine === run && set({ state: 'preparing', progress }))
      .then(
        (ready) => {
          // Turned off while it was getting ready: drop it, and what it wrote after the first delete.
          if (mine !== run) return void (deps.on() ? undefined : clean());
          engine = ready;
          set({ state: 'ready' });
          if (announce) deps.toast('Semantic tool search is ready: beluga_find now finds tools by what they do.', 'success');
        },
        (err: unknown) => {
          if (mine !== run) return void (deps.on() ? undefined : clean());
          const error = err instanceof Error ? err.message : String(err);
          set({ state: 'failed', error });
          deps.toast(`Semantic tool search could not get ready (${error}). beluga_find keeps using its built-in search.`, 'warn');
        },
      );
  };
  const follow = (): void => {
    if (!deps.on()) {
      if (status.state !== 'idle') {
        run++;
        engine = undefined;
        set({ state: 'idle' });
        clean();
      } else if (!started && deps.fetched?.()) clean();
      started = true;
      return;
    }
    started = true;
    if (status.state === 'idle') prepare();
  };
  const rank: SemanticRanking = async (query) => {
    follow();
    return status.state === 'ready' && engine ? engine.rank(query) : undefined;
  };
  return { rank, follow, status: () => status };
}

export interface OpenOptions extends Pick<FetchOptions, 'home' | 'onProgress'> {
  /** Ratel's modules: fetched, checked and loaded by default. */
  readonly load?: (opts: FetchOptions) => Promise<RatelModules>;
}

/**
 * Ratel's semantic catalog over these tools, with bge-small from ~/.beluga. The embeddings are built once into
 * tools-<hash>.rat1, the hash over the SDK, the model and each tool's definition: a start with the same tools warms
 * from it in milliseconds and makes no embedding call, and a Beluga with changed tools embeds again (35 to 60 s).
 */
export async function openSemantic(tools: readonly SearchableTool[], opts: OpenOptions = {}): Promise<MeaningEngine> {
  const { ToolCatalog, experimentalBuildEmbeddingArtifact } = await (opts.load ?? loadSemantic)({ ...(opts.home ? { home: opts.home } : {}), ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) });
  const embedding = { local: modelDir(opts.home), queryPrefix: BGE_SMALL.queryPrefix };
  const meta = tools.map((t) => ({ id: t.name, name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: {} }));
  const dir = semanticDir(opts.home);
  const key = createHash('sha256').update(JSON.stringify([SEMANTIC_VERSION, BGE_SMALL.id, BGE_SMALL.revision, BGE_SMALL.queryPrefix, meta])).digest('hex');
  const name = `tools-${key.slice(0, 16)}.rat1`;
  const file = path.join(dir, name);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    await experimentalBuildEmbeddingArtifact({ output: `${file}.part`, embedding, tools: meta });
    await rename(`${file}.part`, file);
    for (const old of readdirSync(dir)) if (old.endsWith('.rat1') && old !== name) await rm(path.join(dir, old), { force: true });
  }
  const catalog = new ToolCatalog({ method: 'semantic', embedding, experimentalEmbeddingArtifact: { path: file, onMiss: 'embed' } });
  await catalog.register(meta.map((m) => ({ ...m, execute: notHere })));
  return { rank: async (query) => (await catalog.searchAsync(query, meta.length)).map((hit) => hit.toolId) };
}

/** The catalog never runs a tool: a call goes through beluga_call's gate. */
const notHere = (): never => {
  throw new Error('A tool runs only through beluga_call.');
};
