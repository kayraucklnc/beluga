import type { ProseView } from './protocol.js';

/**
 * What of Claude's words go to the phone: everything but code. Fenced blocks (``` or ~~~, any
 * length, closed or not) become a `[[code:n]]` marker on a line of its own and one entry in `code`
 * (its language and how many lines it had), which the phone draws as a "code · 24 lines" chip.
 * Inline `code` stays: it's a word in a sentence, not a listing. Steps go in words too
 * ("Edited store.ts", not the edit). Pure and runtime-free, like protocol.ts.
 */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/;
const MAX_CODE = 200;
/**
 * A picture linked in a chat message ("[📎 image 1 (png, 6K)](klaud-attachment:<owner>/<file>)",
 * src/core/attachment-share.ts ATTACHMENT_SCHEME): the phone can't open that link, so only its
 * words stay ("📎 image 1 (png, 6K)"). Kept here, not imported, so this file stays runtime-free.
 */
const ATTACHMENT_LINK = /\[([^\]\n]*)\]\((?:klaud|beluga)-attachment:[^)\s]*\)/g;

/** Claude's markdown with its code blocks taken out. */
export function stripCode(markdown: string): ProseView {
  const lines = markdown.split('\n');
  const out: string[] = [];
  const code: Array<{ lang?: string; lines: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]!);
    if (!open) {
      out.push(lines[i]!.replace(ATTACHMENT_LINK, '$1'));
      continue;
    }
    const fence = open[1]!;
    const lang = (open[2] ?? '').toLowerCase().slice(0, 40);
    let n = 0;
    let j = i + 1;
    // The block ends at a fence of the same character, at least as long (CommonMark), or at the end.
    for (; j < lines.length; j++) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[j]!);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) break;
      n++;
    }
    if (code.length < MAX_CODE) {
      out.push(`[[code:${code.length}]]`);
      code.push({ ...(lang ? { lang } : {}), lines: n });
    } else out.push('[[code]]');
    i = j;
  }
  return { text: out.join('\n').slice(0, 64_000), code };
}

/** Just the words, one line (a conversation's last line, a notification): markers say "(code)". */
export function plainLine(markdown: string, max = 300): string {
  const { text } = stripCode(markdown);
  const line = text
    .replace(/\[\[code(?::\d+)?\]\]/g, '(code)')
    .replace(/[*_#>`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

const base = (p: string): string => p.replace(/\/+$/, '').split('/').at(-1) ?? p;
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** How a tool's step reads on the phone: a verb and a file name, never its code or diff. */
const VERBS: Readonly<Record<string, (arg: string) => string>> = {
  Read: (a) => (a ? `Read ${base(a)}` : 'Read a file'),
  Edit: (a) => (a ? `Edited ${base(a)}` : 'Edited a file'),
  MultiEdit: (a) => (a ? `Edited ${base(a)}` : 'Edited a file'),
  Write: (a) => (a ? `Wrote ${base(a)}` : 'Wrote a file'),
  NotebookEdit: (a) => (a ? `Edited ${base(a)}` : 'Edited a notebook'),
  Grep: (a) => (a ? `Searched for ${clip(a.replace(/^"|"$/g, ''), 40)}` : 'Searched the code'),
  Glob: () => 'Looked for files',
  LS: () => 'Looked through a folder',
  WebFetch: (a) => {
    const host = /^https?:\/\/([^/]+)/.exec(a)?.[1];
    return host ? `Read a page on ${host}` : 'Read a web page';
  },
  WebSearch: (a) => (a ? `Searched the web for ${clip(a, 40)}` : 'Searched the web'),
  Task: (a) => (a ? `Started a sub-agent: ${clip(a, 60)}` : 'Started a sub-agent'),
  Agent: (a) => (a ? `Started a sub-agent: ${clip(a, 60)}` : 'Started a sub-agent'),
  TodoWrite: () => 'Updated its to-do list',
  // A command: its program and first word ("Ran npm test"), never the whole line.
  Bash: (a) => {
    const words = a.trim().split(/\s+/).filter((w) => !/^[A-Z_]+=/.test(w));
    const what = words.slice(0, words[0] && /^(npm|npx|pnpm|yarn|bun|git|cargo|go|make|python3?|node)$/.test(words[0]) ? 2 : 1).join(' ');
    return what ? `Ran ${clip(what, 40)}` : 'Ran a command';
  },
};

/** A step of Claude's ("Edit src/store.ts", "Bash npm test", "mcp__beluga__show") in words. */
export function humanizeStep(step: string): string {
  const s = step.trim();
  const at = s.indexOf(' ');
  const tool = at < 0 ? s : s.slice(0, at);
  const arg = at < 0 ? '' : s.slice(at + 1).trim();
  const verb = VERBS[tool];
  if (verb) return clip(verb(arg), 300);
  // MCP tools and Beluga's own: their name in words ("task define" → "Used task define").
  const name = tool.replace(/^mcp__.+?__/, '').replace(/[_-]+/g, ' ').trim();
  if (/^[a-z][\w ]*$/i.test(name) && name.length <= 40 && (tool.startsWith('mcp__') || /_/.test(tool))) return clip(`Used ${name}`, 300);
  // Anything else (a sub-agent's own words, a count): as it is, without code fences.
  return clip(plainLine(s, 300) || 'Working', 300);
}
