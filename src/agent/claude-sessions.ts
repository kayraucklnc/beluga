import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk';
import { type Conversation, type ConversationSummary, type TranscriptMessage, transcriptToLog, typedText } from './transcript.js';

/**
 * Finding the Claude Code conversations that ran in a folder (a worktree made by Conductor or
 * by Claude Code itself). Claude Code keeps each one in
 * ~/.claude/projects/<the folder, every non-alphanumeric character as "->/<session>.jsonl.
 */

/** Where Claude Code keeps its data (CLAUDE_CONFIG_DIR, else ~/.claude). */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** The folder name Claude Code files a working directory's sessions under. */
export const encodeProjectDir = (dir: string): string => dir.replace(/[^a-zA-Z0-9]/g, '-');

/** macOS top-level folders that are symlinks into /private. */
const PRIVATE_LINKS = ['/tmp', '/var', '/etc'];

const realOf = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * Every way the same folder may be spelled: as given, with symlinks resolved, and with or
 * without macOS's /private prefix (/tmp/x and /private/tmp/x are one folder).
 */
export function pathVariants(dir: string): string[] {
  const out = new Set([path.resolve(dir), realOf(dir)]);
  for (const v of [...out]) {
    for (const top of PRIVATE_LINKS) {
      const priv = `/private${top}`;
      if (v === priv || v.startsWith(`${priv}/`)) out.add(v.slice('/private'.length));
      else if (v === top || v.startsWith(`${top}/`)) out.add(`/private${v}`);
    }
  }
  return [...out];
}

/** Whether two paths name the same folder (symlinks and /private resolved). */
export function samePath(a: string, b: string): boolean {
  const theirs = new Set(pathVariants(b));
  return pathVariants(a).some((v) => theirs.has(v));
}

const WRAPPERS = /<(system_instruction|system-instruction)>[\s\S]*?<\/\1>/g;
const MAX_TITLE = 80;

/** A session's title as people read it: theirs, Claude Code's, or the first thing typed. */
export function sessionTitle(info: { customTitle?: string; summary?: string; firstPrompt?: string }): string {
  const raw = info.customTitle || info.summary || info.firstPrompt || 'Untitled conversation';
  const clean = raw.replace(WRAPPERS, ' ').replace(/\s+/g, ' ').trim() || 'Untitled conversation';
  return clean.length > MAX_TITLE ? `${clean.slice(0, MAX_TITLE - 1).trimEnd()}…` : clean;
}

type Info = { sessionId: string; summary: string; lastModified: number; customTitle?: string; firstPrompt?: string; cwd?: string; createdAt?: number };
const summaryOf = (s: Info): ConversationSummary => ({ sessionId: s.sessionId, title: sessionTitle(s), lastModified: s.lastModified, ...(s.createdAt ? { createdAt: s.createdAt } : {}) });

/** Transcript files filed under one spelling of a folder. */
function sessionFilesIn(dir: string): string[] {
  const folder = path.join(claudeConfigDir(), 'projects', encodeProjectDir(dir));
  if (!existsSync(folder)) return [];
  try {
    return readdirSync(folder)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(folder, f));
  } catch {
    return [];
  }
}

const PEEK = 256 * 1024;

/** The start and end of a (possibly huge) transcript: enough for its folder, first prompt and title. */
async function peek(file: string, size: number): Promise<string[]> {
  const fh = await open(file, 'r');
  try {
    const read = async (at: number, len: number): Promise<string> => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, at);
      return buf.subarray(0, bytesRead).toString('utf8');
    };
    if (size <= PEEK * 2) return (await read(0, size)).split('\n');
    // Drop the partial lines where the two pieces were cut.
    return [...(await read(0, PEEK)).split('\n').slice(0, -1), ...(await read(size - PEEK, PEEK)).split('\n').slice(1)];
  } finally {
    await fh.close();
  }
}

type Line = { type?: string; cwd?: string; timestamp?: string; customTitle?: string; aiTitle?: string; summary?: string; isSidechain?: boolean; isMeta?: boolean; message?: unknown };

/**
 * A transcript the SDK doesn't list (it skips ones whose every prompt starts with a tag, like
 * Conductor's <system_instruction>, when there's no title yet), summarized from the file itself.
 */
async function summarizeFile(file: string): Promise<Info | undefined> {
  const st = await stat(file).catch(() => undefined);
  if (!st) return undefined;
  const lines = await peek(file, st.size).catch(() => [] as string[]);
  let cwd: string | undefined;
  let createdAt: number | undefined;
  let firstPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let sidechain = false;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    if (l.type === 'custom-title' && l.customTitle) customTitle = l.customTitle;
    if (l.type === 'ai-title' && l.aiTitle) aiTitle = l.aiTitle;
    if (l.type !== 'user' && l.type !== 'assistant') continue;
    cwd ??= l.cwd;
    if (l.timestamp && createdAt === undefined) createdAt = Date.parse(l.timestamp) || undefined;
    if (l.isSidechain && firstPrompt === undefined) sidechain = true;
    if (l.type === 'user' && !l.isMeta && firstPrompt === undefined) {
      const text = typedText(l.message);
      if (text && !text.startsWith('<')) firstPrompt = text;
    }
  }
  if (sidechain || !firstPrompt) return undefined;
  return { sessionId: path.basename(file, '.jsonl'), summary: aiTitle ?? firstPrompt, lastModified: Math.round(st.mtimeMs), ...(customTitle ? { customTitle } : {}), firstPrompt, ...(cwd ? { cwd } : {}), ...(createdAt ? { createdAt } : {}) };
}

/** Every Claude Code conversation that ran in exactly this folder, newest first. */
export async function listConversations(dir: string, limit = 50): Promise<ConversationSummary[]> {
  const found = new Map<string, ConversationSummary>();
  const fromSdk = (await listSessions({ dir, includeWorktrees: false, limit }).catch(() => [])) as Info[];
  for (const s of fromSdk) if (!s.cwd || samePath(s.cwd, dir)) found.set(s.sessionId, summaryOf(s));
  // Sessions the SDK didn't list: filed under another spelling of the folder (e.g. /tmp/x for
  // /private/tmp/x), or skipped by it for having no title yet.
  for (const variant of pathVariants(dir)) {
    for (const file of sessionFilesIn(variant)) {
      if (found.has(path.basename(file, '.jsonl'))) continue;
      const info = await summarizeFile(file);
      if (info && (!info.cwd || samePath(info.cwd, dir))) found.set(info.sessionId, summaryOf(info));
    }
  }
  return [...found.values()].sort((a, b) => b.lastModified - a.lastModified).slice(0, limit);
}

async function messagesOf(sessionId: string, dir: string): Promise<TranscriptMessage[]> {
  const inDir = (await getSessionMessages(sessionId, { dir }).catch(() => [])) as TranscriptMessage[];
  if (inDir.length) return inDir;
  // Filed under another spelling of the folder: look it up by id alone.
  return (await getSessionMessages(sessionId).catch(() => [])) as TranscriptMessage[];
}

export interface FindOptions {
  /** Exactly this conversation (it must have run in the folder). */
  readonly sessionId?: string;
  /** Try this one first (e.g. the one Conductor has open), then the newest. */
  readonly prefer?: string;
}

/**
 * A Claude Code conversation that ran in this folder, ready to show and to continue: the one
 * asked for, else the preferred one, else the newest that has something to show.
 */
export async function findConversation(dir: string, self: { id: string; name: string }, opts: FindOptions = {}): Promise<Conversation | undefined> {
  const all = await listConversations(dir);
  const candidates = opts.sessionId
    ? all.filter((c) => c.sessionId === opts.sessionId)
    : [...all.filter((c) => c.sessionId === opts.prefer), ...all.filter((c) => c.sessionId !== opts.prefer)].slice(0, 4);
  for (const pick of candidates) {
    const messages = await messagesOf(pick.sessionId, dir);
    // Claude Code records resolved paths, so steps read relative to the resolved folder.
    const items = transcriptToLog(messages, { selfId: self.id, selfName: self.name, cwd: realOf(dir), start: pick.createdAt ?? pick.lastModified, end: pick.lastModified });
    if (items.length) return { ...pick, items, all };
  }
  return undefined;
}
