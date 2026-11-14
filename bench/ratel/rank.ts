// How well beluga_find ranks Beluga's hidden tools, on hand-written intents: the built-in BM25, and with --semantic
// semantic tool search (Ratel + bge-small, fetched and embedded by the same code as the daemon).
// A gold tool that the client lists counts as found at rank 1.
//
//   npx tsx bench/ratel/rank.ts              BM25 only
//   npx tsx bench/ratel/rank.ts --semantic   also semantic: the first run fetches about 138 MB into BELUGA_HOME
//                                            (default: a folder in the system temp) and embeds the tools once
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openSemantic } from '../../src/external/adapters/semantic-search.js';
import { schemaOf } from '../../src/external/adapters/tools/discover.js';
import { bm25Ranking } from '../../src/external/domain/tool-search.js';
import { externalTools, type ToolPorts } from '../../src/external/launch.js';

interface Intent {
  readonly q: string;
  readonly gold: readonly string[];
  readonly kind: string;
}

const here = (file: string): string => path.join(import.meta.dirname, file);
const SETS: Readonly<Record<string, string>> = { kw: 'shares words', para: 'paraphrase only', 'e2e kw': 'asks, shares words', 'e2e para': 'asks, paraphrase' };

process.env.BELUGA_HOME ??= path.join(os.tmpdir(), 'beluga-bench-semantic');
const intents: Intent[] = [...JSON.parse(readFileSync(here('intents.json'), 'utf8')), ...JSON.parse(readFileSync(here('e2e-intents.json'), 'utf8')).map((i: Intent) => ({ ...i, kind: `e2e ${i.kind}` }))];
// The tool list only: no daemon, so every port is a stub that is never called.
const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
const { listed, others } = externalTools(stub as ToolPorts);
const listedNames = new Set(listed.map((t) => t.name as string));
const hidden = others.map((def) => ({ name: def.name, description: def.description, inputSchema: schemaOf(def) }));
console.log(`${listed.length + 2} tools listed (with beluga_find and beluga_call), ${hidden.length} hidden, ${intents.length} intents\n`);

const rankers: Array<[string, (q: string) => Promise<readonly string[]>]> = [['Built-in BM25', async (q) => bm25Ranking(hidden)(q)]];
if (process.argv.includes('--semantic')) {
  const started = performance.now();
  let said = false;
  const engine = await openSemantic(hidden, { onProgress: ({ done, total }) => done === total && !said && (said = true) && console.log(`fetched ${(total / 1e6).toFixed(1)} MB`) });
  console.log(`semantic ready in ${Math.round(performance.now() - started)} ms (a second run warms from the .rat1 file in ${process.env.BELUGA_HOME})\n`);
  rankers.push(['Semantic (bge-small)', (q) => engine.rank(q)]);
}

console.log('| Ranker | Set | n | top-1 | top-8 |\n|---|---|---|---|---|');
for (const [name, rank] of rankers) {
  const score = new Map<string, { n: number; at1: number; at8: number }>();
  for (const it of intents) {
    const visible = it.gold.find((g) => listedNames.has(g));
    const ids = visible ? [visible] : await rank(it.q);
    for (const set of [it.kind, 'all']) {
      const s = score.get(set) ?? { n: 0, at1: 0, at8: 0 };
      s.n++;
      if (it.gold.includes(ids[0] ?? '')) s.at1++;
      if (ids.slice(0, 8).some((id) => it.gold.includes(id))) s.at8++;
      score.set(set, s);
    }
  }
  for (const [set, s] of score) console.log(`| ${name} | ${SETS[set] ?? set} | ${s.n} | ${Math.round((100 * s.at1) / s.n)}% | ${Math.round((100 * s.at8) / s.n)}% |`);
}
