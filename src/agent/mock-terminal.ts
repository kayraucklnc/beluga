import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { belugaHome } from '../core/home.js';
import { GRAPH_FENCE } from '../shared/graph-spec.js';
import { visualToken } from '../shared/term-visuals.js';
import { VIEW_FENCE, viewBlock } from '../shared/view-spec.js';
import { PAYMENT_FLOW } from './mock-graphs.js';
import { DEMO_CUSTOMERS } from './mock-views.js';
import type { AgentRunInput, TerminalLaunch, TerminalSink } from './types.js';

/**
 * The demo's agent terminal (BLG-534): a small stand-in for Claude Code's terminal app, so the
 * terminal view runs without Claude (e2e, GIFs). It answers like the demo's Claude does, shows a
 * graph and a table as links, and writes a transcript the way Claude Code does, in the demo's own
 * folder (never your ~/.claude), so its turns come back to the chat.
 */

/** Where the demo's terminal writes its transcripts (as Claude Code's own folder is laid out). */
export const demoClaudeDir = (home = belugaHome()): string => path.join(home, 'demo-claude');

/** The stand-in itself: plain Node, run with `node -e`. Reads its settings from the environment. */
const SCRIPT = String.raw`
const proc = process;
const fs = require('fs');
const path = require('path');
const file = process.env.DEMO_TRANSCRIPT;
const session = process.env.DEMO_SESSION;
const cwd = process.cwd();
const graph = process.env.DEMO_GRAPH, table = process.env.DEMO_TABLE, task = process.env.DEMO_TASK || '';
const cards = process.env.DEMO_CARDS, picture = process.env.DEMO_PICTURE || '';
const E = '\x1b[';
const dim = (s) => E + '2m' + s + E + '22m', bold = (s) => E + '1m' + s + E + '22m';
const copper = (s) => E + '38;2;223;148;106m' + s + E + '39m', green = (s) => E + '32m' + s + E + '39m';
const out = (s) => proc.stdout.write(s);
const write = (entry) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ...entry, sessionId: session, cwd, timestamp: new Date().toISOString(), uuid: require('crypto').randomUUID() }) + '\n');
};
out(copper('✻') + ' ' + bold('Claude Code') + dim('  (demo) · ' + path.basename(cwd)) + '\r\n\r\n');
const prompt = () => out(copper('> '));
let line = '';
let busy = false;
const answer = (text) => {
  const t = text.toLowerCase();
  if (/graph|diagram|map|flow|visual/.test(t)) return ['Here is how a payment moves through the system:', '', '[[visual:' + graph + ']]', '', 'Webhooks retry with backoff when the shop is down.'];
  if (/table|customer|revenue|rows/.test(t)) return ['Your top customers by revenue:', '', '[[visual:' + table + ']]', '', '| customer | revenue |', '|---|---|', '| Acme | $84,210 |', '| Globex | $61,900 |', '| Initech | $47,350 |'];
  if (/task/.test(t)) return ['Auth BOB-3 waits on bob\'s review; the webhook retries are under way:', '', '[[visual:' + cards + ']]'];
  if (/picture|screenshot|image/.test(t) && picture) return ['I took a screenshot of the checkout page:', '', picture];
  return ['Done. I looked through the project and everything is in order.'];
};
const reply = (text) => {
  busy = true;
  write({ type: 'user', message: { role: 'user', content: text } });
  out(dim('  ⎿  Thinking…') + '\r\n');
  setTimeout(() => {
    const lines = answer(text);
    out(green('⏺') + ' ' + lines[0] + '\r\n');
    for (const l of lines.slice(1)) out('  ' + l + '\r\n');
    out('\r\n');
    write({ type: 'assistant', message: { role: 'assistant', model: 'demo', content: [{ type: 'text', text: lines.join('\n') }] } });
    busy = false;
    prompt();
  }, 400);
};
if (proc.stdin.isTTY) proc.stdin.setRawMode(true);
proc.stdin.setEncoding('utf8');
proc.stdin.on('data', (data) => {
  for (const ch of data) {
    if (ch === '\x03' || ch === '\x04') { out('\r\n'); process.exit(0); }
    if (busy) continue;
    if (ch === '\r' || ch === '\n') {
      const text = line.trim();
      line = '';
      out('\r\n');
      if (text) reply(text); else prompt();
    } else if (ch === '\x7f') {
      if (line) { line = line.slice(0, -1); out('\b \b'); }
    } else if (ch >= ' ') {
      line += ch;
      out(ch);
    }
  }
});
// A message sent from the chat comes as the first prompt, as Claude Code's does (BLG-553).
const first = process.env.DEMO_FIRST || '';
if (first) {
  out(copper('> ') + first + '\r\n');
  reply(first);
} else prompt();
`;

/** The demo's terminal on a conversation: its graph and table kept for its links, its transcript in the demo's folder. */
export function mockTerminal(input: AgentRunInput, sink: TerminalSink, home?: string): TerminalLaunch {
  const place = input.place;
  if (!place) throw new Error('This conversation has no folder to open a terminal in.');
  const resume = place.resume && !place.forkSession ? place.resume : undefined;
  const session = resume ?? randomUUID();
  const dir = demoClaudeDir(home);
  const graph = sink.add(viewBlock(PAYMENT_FLOW, GRAPH_FENCE));
  const table = sink.add(viewBlock(DEMO_CUSTOMERS, VIEW_FENCE));
  // What show_block keeps: task cards, as the chat draws them.
  const cards = sink.add('```beluga-tasks\nBOB-3\nBOB-4\n```');
  const picture = [path.resolve('docs/guide/img/02-working.jpg'), path.resolve('../../docs/guide/img/02-working.jpg')].find((p) => existsSync(p)) ?? '';
  const transcript = path.join(dir, 'projects', place.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${session}.jsonl`);
  return {
    file: process.execPath,
    args: ['-e', SCRIPT],
    env: { ...input.env, DEMO_TRANSCRIPT: transcript, DEMO_SESSION: session, DEMO_GRAPH: String(graph), DEMO_TABLE: String(table), DEMO_CARDS: String(cards), DEMO_PICTURE: picture, DEMO_TOKEN: visualToken(graph), ...(input.prompt ? { DEMO_FIRST: input.prompt } : {}) },
    transcriptHome: dir,
    session,
    fresh: !resume,
    close: () => undefined,
  };
}
