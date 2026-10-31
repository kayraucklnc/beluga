import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { claudeConfigDir, encodeProjectDir, pathVariants } from '../agent/runtime/claude/claude-sessions.js';
import { type TranscriptMessage, transcriptToTurns } from '../agent/transcript.js';
import type { StepRecord } from '../shared/steps.js';
import { expandVisuals } from '../shared/term-visuals.js';
import type { LogItem } from './store.js';

/**
 * The agent's terminal turns, back into the chat (BLG-534). What you and Claude say in Claude
 * Code's own terminal app is written by it to its transcript (~/.claude/projects/…/<session>.jsonl).
 * Beluga reads what was added since the terminal opened and shows it as the chat's own turns,
 * visuals drawn where their tokens were.
 */

/** Bytes read from a transcript per look (a big paste or a long turn is read over a few looks). */
const CHUNK = 1 << 20;

/** Where Claude Code keeps a session's transcript for a folder (any spelling of the folder), if it's there yet. */
export function claudeTranscriptFile(cwd: string, session: string, configDir = claudeConfigDir()): string | undefined {
  for (const variant of pathVariants(cwd)) {
    const file = path.join(configDir, 'projects', encodeProjectDir(variant), `${session}.jsonl`);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** A transcript read as it grows: whole lines since `offset`. */
export class TranscriptTail {
  readonly lines: string[] = [];
  private rest = '';

  constructor(
    readonly file: string,
    private offset: number,
  ) {}

  /** Whatever was written since the last look; true when there were new lines. */
  read(): boolean {
    let fd: number | undefined;
    let grew = false;
    try {
      const size = statSync(this.file).size;
      if (size < this.offset) return false; // rewritten under us: keep what we have
      fd = openSync(this.file, 'r');
      while (this.offset < size) {
        const buf = Buffer.alloc(Math.min(CHUNK, size - this.offset));
        const n = readSync(fd, buf, 0, buf.length, this.offset);
        if (!n) break;
        this.offset += n;
        const text = this.rest + buf.subarray(0, n).toString('utf8');
        const parts = text.split('\n');
        this.rest = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) this.lines.push(line), (grew = true);
      }
    } catch {
      return grew;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    return grew;
  }
}

/** The size of a file now (0 when there's none yet): where a terminal's new turns start. */
export const sizeOf = (file: string | undefined): number => (file ? (statSync(file, { throwIfNoEntry: false })?.size ?? 0) : 0);

export interface TurnsOptions {
  readonly selfId: string;
  readonly selfName: string;
  readonly cwd: string;
  /** Ids are made unique per terminal (`term-<key>-…`), so a later one never replaces this one's. */
  readonly key: string;
  /** A visual's block by its number, for the chat (shared/term-visuals.ts). */
  readonly visual: (n: number) => string | undefined;
  /**
   * Lines written before this are the chat's already: a forked conversation starts with a copy of
   * the one it came from, with that one's times.
   */
  readonly since?: number;
}

/** Whether a line was written before the terminal opened (and so is already in the chat). */
const before = (line: { timestamp?: unknown }, since: number | undefined): boolean => {
  if (since === undefined) return false;
  const at = timeOf(line);
  return at !== undefined && at < since;
};

export interface Turns {
  readonly items: LogItem[];
  readonly steps: Record<string, StepRecord[]>;
}

const timeOf = (line: { timestamp?: unknown }): number | undefined => {
  const t = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  return Number.isNaN(t) ? undefined : t;
};

/** The chat's own items for what was said, ids made this terminal's and visuals put in. */
function finish(turns: Turns, opts: TurnsOptions): Turns {
  const id = (raw: string): string => `term-${opts.key}-${raw}`;
  const items = turns.items.map((it) => {
    const own = { ...it, id: id(it.id) } as LogItem;
    if (own.type === 'agent') return { ...own, requestId: id(it.id), text: expandVisuals(own.text, opts.visual) || '(worked without a written answer)' } as LogItem;
    return own;
  });
  return { items, steps: Object.fromEntries(Object.entries(turns.steps).map(([k, v]) => [id(k), v])) };
}

/** Claude Code's lines (since the terminal opened) as the chat's turns. */
export function claudeTurns(lines: readonly string[], opts: TurnsOptions): Turns {
  const messages: TranscriptMessage[] = [];
  let start: number | undefined;
  let end: number | undefined;
  for (const raw of lines) {
    let l: { type?: string; message?: unknown; isSidechain?: boolean; isMeta?: boolean; timestamp?: unknown };
    try {
      l = JSON.parse(raw) as typeof l;
    } catch {
      continue;
    }
    if ((l.type !== 'user' && l.type !== 'assistant') || l.isSidechain || l.isMeta || before(l, opts.since)) continue;
    const at = timeOf(l);
    if (at !== undefined) {
      start ??= at;
      end = at;
    }
    messages.push({ type: l.type, message: l.message, parent_tool_use_id: null });
  }
  if (!messages.length) return { items: [], steps: {} };
  const now = Date.now();
  return finish(transcriptToTurns(messages, { selfId: opts.selfId, selfName: opts.selfName, cwd: opts.cwd, start: start ?? now, end: end ?? start ?? now }), opts);
}
