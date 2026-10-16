import type { LogItem } from '../core/store.js';

export interface Line {
  readonly text: string;
  readonly color?: string;
  readonly bold?: boolean;
  readonly dim?: boolean;
}

const PALETTE = ['cyan', 'green', 'yellow', 'blue', 'magenta', 'redBright', 'cyanBright', 'greenBright'];

export function colorFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? 'cyan';
}

/** Word-aware hard wrap that never returns lines wider than `width`. */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(4, width);
  const out: string[] = [];
  for (const para of text.replace(/\t/g, '  ').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if ((line + word).length <= w) {
        line += word;
        continue;
      }
      if (line.trim()) out.push(line.trimEnd());
      line = word.trimStart();
      while (line.length > w) {
        out.push(line.slice(0, w));
        line = line.slice(w);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

const time = (ts: number): string => new Date(ts).toTimeString().slice(0, 5);

const STATUS: Record<string, { icon: string; label: string; color: string }> = {
  awaiting_approval: { icon: '⏳', label: 'waiting for approval', color: 'yellow' },
  started: { icon: '◆', label: 'working…', color: 'magenta' },
  text: { icon: '◆', label: 'working…', color: 'magenta' },
  tool: { icon: '◆', label: 'working…', color: 'magenta' },
  done: { icon: '✓', label: 'done', color: 'green' },
  error: { icon: '✗', label: 'failed', color: 'red' },
  denied: { icon: '⊘', label: 'declined', color: 'yellow' },
};

function agentLines(item: Extract<LogItem, { type: 'agent' }>, width: number): Line[] {
  const st = STATUS[item.status] ?? STATUS.started!;
  const header: Line = {
    text: `${time(item.ts)} ${st.icon} ${item.ownerName}'s claude ← ${item.requesterName} · ${st.label}`,
    color: st.color,
    bold: true,
  };
  const running = item.status === 'started';
  const steps: Line[] = (running ? item.steps : item.steps.slice(-2)).flatMap((s) =>
    wrapText(`↳ ${s}`, width - 4).map((t) => ({ text: `    ${t}`, dim: true })),
  );
  const body = wrapText(item.text, width - 4).filter((t, i, all) => t || i < all.length - 1);
  return [header, ...steps, ...(item.text ? body.map((t) => ({ text: `    ${t}` })) : [])];
}

/** Flatten the room log into terminal lines for a pane of the given width. */
export function renderLog(items: readonly LogItem[], width: number, selfId?: string): Line[] {
  return items.flatMap((item): Line[] => {
    if (item.type === 'system') {
      const color = item.level === 'error' ? 'red' : item.level === 'warn' ? 'yellow' : 'gray';
      return wrapText(item.text, width - 2).map((t) => ({ text: `  ${t}`, color, dim: item.level === 'info' }));
    }
    if (item.type === 'agent') return agentLines(item, width);
    const prefix = `${time(item.ts)} ${item.byAgent ? '◆ ' : ''}${item.name}${item.from === selfId && !item.byAgent ? ' (you)' : ''}: `;
    const [first = '', ...rest] = wrapText(prefix + item.text, width);
    return [
      { text: first, color: item.byAgent ? 'magenta' : colorFor(item.name.replace(/'s claude$/, '')), bold: false },
      ...rest.map((t) => ({ text: t })),
    ];
  });
}

/** Pick the visible window of lines given a scroll offset from the bottom. */
export function windowLines<T>(lines: readonly T[], height: number, scrollFromBottom: number): T[] {
  const maxScroll = Math.max(0, lines.length - height);
  const scroll = Math.min(scrollFromBottom, maxScroll);
  const end = lines.length - scroll;
  return lines.slice(Math.max(0, end - height), end);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}

const APPROVAL_LINES = 6;

/** Wrap an approval's detail (e.g. a shell command) so the owner sees as much of it as possible. */
export function approvalLines(detail: string, width: number): string[] {
  const lines = wrapText(detail, width);
  if (lines.length <= APPROVAL_LINES) return lines;
  return [...lines.slice(0, APPROVAL_LINES - 1), `… ${lines.length - APPROVAL_LINES + 1} more lines (${detail.length} chars)`];
}
