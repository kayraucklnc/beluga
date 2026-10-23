import type { ElkInput, ElkOutput } from './graph-model.js';

/**
 * ELK lays graphs out (layered, groups as boxes around their nodes). In the window it runs in a
 * worker (elk.worker.ts), so a big graph never freezes anything, and a layout that takes too long
 * is stopped (the worker is replaced). Where there are no workers (tests) it runs right here.
 */

export const LAYOUT_TIMEOUT_MS = 8000;

interface Elk {
  layout(graph: ElkInput): Promise<ElkOutput>;
  terminateWorker?(): void;
}
type ElkClass = new (opts?: { workerFactory?: () => Worker }) => Elk;

// (A module's default export is the class; how it's typed depends on who compiles it.)
const classOf = (mod: unknown): ElkClass => ((mod as { default?: unknown }).default ?? mod) as ElkClass;

let threaded: Promise<Elk> | undefined;
let local: Promise<Elk> | undefined;

function inWorker(graph: ElkInput, timeoutMs: number): Promise<ElkOutput> {
  threaded ??= import('elkjs/lib/elk-api.js').then((mod) => new (classOf(mod))({ workerFactory: () => new Worker(new URL('./elk.worker.ts', import.meta.url), { type: 'module', name: 'beluga-graph-layout' }) }));
  const mine = threaded;
  return mine.then(
    (elk) =>
      new Promise<ElkOutput>((resolve, reject) => {
        const timer = setTimeout(() => {
          // Stuck: stop the worker (anything else it was doing fails too, and falls back).
          elk.terminateWorker?.();
          if (threaded === mine) threaded = undefined;
          reject(new Error('layout took too long'));
        }, timeoutMs);
        elk.layout(graph).then(
          (out) => (clearTimeout(timer), resolve(out)),
          (err: unknown) => (clearTimeout(timer), reject(err instanceof Error ? err : new Error(String(err)))),
        );
      }),
  );
}

function here(graph: ElkInput): Promise<ElkOutput> {
  local ??= import('elkjs/lib/elk.bundled.js').then((mod) => new (classOf(mod))());
  // ELK writes positions into what it's given: hand it a copy.
  return local.then((e) => e.layout(structuredClone(graph) as ElkInput));
}

export function layout(graph: ElkInput, timeoutMs = LAYOUT_TIMEOUT_MS): Promise<ElkOutput> {
  return typeof Worker === 'undefined' ? here(graph) : inWorker(graph, timeoutMs);
}
