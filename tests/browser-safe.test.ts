import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the Mac app's web view loads from the shared source: the client store and reducers,
 * the API list and the socket client. None of it may need Node at runtime (type-only imports
 * are fine: they disappear when compiled).
 */
const ENTRIES = ['src/client/client-store.ts', 'src/client/screen.ts', 'src/ipc/api.ts', 'src/ipc/client.ts', 'src/ipc/protocol.ts', 'src/ipc/socket-client.ts', 'src/shared/codec.ts'];
const ALLOWED_PACKAGES = new Set(['zod']);
const NODE = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Runtime imports of a file (skips `import type` and type-only specifier lists). */
function runtimeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) {
    if (m[2]) continue;
    const names = m[3] ?? '';
    // `import { type A, type B } from` is type-only too.
    const list = /^\{([^}]*)\}$/.exec(names.trim());
    if (list && list[1]!.split(',').every((n) => !n.trim() || n.trim().startsWith('type '))) continue;
    out.push(m[4]!);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!);
  return out;
}

function walk(entry: string, seen = new Map<string, string[]>()): Map<string, string[]> {
  const abs = path.resolve(entry);
  if (seen.has(abs)) return seen;
  const imports = runtimeImports(abs);
  seen.set(abs, imports);
  for (const spec of imports) {
    if (!spec.startsWith('.')) continue;
    walk(path.resolve(path.dirname(abs), spec.replace(/\.js$/, '.ts')), seen);
  }
  return seen;
}

describe('browser-safe client code', () => {
  const graph = new Map<string, string[]>();
  for (const e of ENTRIES) walk(e, graph);

  it('covers the shared reducer and the protocol', () => {
    const files = [...graph.keys()].map((f) => path.relative(process.cwd(), f));
    expect(files).toEqual(expect.arrayContaining(['src/core/store.ts', 'src/core/collab-store.ts', 'src/core/work-store.ts', 'src/protocol.ts', 'src/shared/settings-schema.ts']));
  });

  it('needs nothing from Node and no packages but zod', () => {
    const offenders = [...graph.entries()].flatMap(([file, imports]) =>
      imports.filter((spec) => !spec.startsWith('.') && (NODE.has(spec) || !ALLOWED_PACKAGES.has(spec))).map((spec) => `${path.relative(process.cwd(), file)} → ${spec}`),
    );
    expect(offenders).toEqual([]);
  });
});
