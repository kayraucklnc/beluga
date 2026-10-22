/**
 * How far a long command has got, from what it printed: "137/215" from a test runner's
 * "[137/215]", "137/215 tests", or "Tests 137 passed (215)". Undefined when the output doesn't
 * say (a date like 10/22 never counts: the count needs brackets or a word after it).
 * Browser-safe: the runner reads it from a command's output, screens show it on a task's card.
 */

const PATTERNS: readonly RegExp[] = [
  // Playwright's list and line reporters, cargo, many others: "[137/215]".
  /\[\s*(\d+)\s*\/\s*(\d+)\s*\]/g,
  // "137/215 tests", "137 / 215 passed", "137/215 done".
  /\b(\d+)\s*\/\s*(\d+)\s+(?:tests?|specs?|passed|done|files?|suites?|completed|steps?)\b/gi,
  // Vitest and Jest summaries: "Tests  137 passed (215)".
  /\b(\d+)\s+passed\s*\((\d+)\)/gi,
];

export function progressCount(output: string): string | undefined {
  // The last lines say where it is now (earlier counts are where it was).
  const tail = output.length > 8000 ? output.slice(-8000) : output;
  let best: { at: number; text: string } | undefined;
  for (const re of PATTERNS) {
    for (const m of tail.matchAll(re)) {
      const done = Number(m[1]);
      const total = Number(m[2]);
      if (!(total > 0) || done > total) continue;
      if (!best || m.index! >= best.at) best = { at: m.index!, text: `${done}/${total}` };
    }
  }
  return best?.text;
}
