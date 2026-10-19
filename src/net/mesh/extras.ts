import path from 'node:path';
import { z } from 'zod';
import { PeerIdSchema } from './schemas.js';
import type { ChatExtras, ChatFile } from './views.js';

/**
 * What a chat message can carry besides its text, inside the encryption (a group message's
 * sealed JSON, a direct message's Noise link): files (by checksum; the bytes travel separately,
 * see core/chat-files), a call for Claudes to answer (`ask`), or that it is a Claude's answer
 * (`claude`). Older Macs read only `text` and ignore the rest.
 */

/** The biggest file a chat can share (it's pulled in pieces, straight from Mac to Mac). */
export const MAX_CHAT_FILE = 4 * 1024 ** 3;
/** Files on one message. */
export const MAX_FILES = 20;

const hex64 = z.string().regex(/^[0-9a-f]{64}$/);

/** A file name that can't climb out of a folder or hide its kind: no paths, no control characters. */
export function cleanFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').replace(/^\.+/, '').trim().slice(0, 200);
  return clean || 'file';
}

export const ChatFileSchema = z.object({
  sha: hex64,
  name: z.string().min(1).max(200).transform(cleanFileName),
  size: z.number().int().min(0).max(MAX_CHAT_FILE),
  mime: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
  image: z.boolean().optional(),
});

export const ExtrasSchema = z.object({
  files: z.array(ChatFileSchema).max(MAX_FILES).optional(),
  ask: z.object({ to: z.union([z.literal('all'), z.array(PeerIdSchema).min(1).max(100)]) }).optional(),
  claude: z.object({ for: z.string().min(1).max(80) }).optional(),
});

/** The extras of a message as they came (anything malformed is dropped; nothing at all: undefined). */
export function parseExtras(raw: unknown): ChatExtras | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const parsed = ExtrasSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { files, ask, claude } = parsed.data;
  const out: { files?: ChatFile[]; ask?: ChatExtras['ask']; claude?: ChatExtras['claude'] } = {};
  if (files?.length) out.files = files.map((f) => ({ sha: f.sha, name: f.name, size: f.size, ...(f.mime ? { mime: f.mime } : {}), ...(f.image ? { image: true } : {}) }));
  if (ask) out.ask = ask;
  if (claude) out.claude = claude;
  return Object.keys(out).length ? out : undefined;
}

/** The fields to spread into a message or a view: nothing when there are no extras. */
export const extrasFields = (x: ChatExtras | undefined): ChatExtras => (x ? { ...(x.files ? { files: x.files } : {}), ...(x.ask ? { ask: x.ask } : {}), ...(x.claude ? { claude: x.claude } : {}) } : {});

/** A message needs words, files, or both. */
export function checkMessage(text: string, extras: ChatExtras | undefined, maxText: number): void {
  if (text.length > maxText) throw new Error(`Messages are at most ${maxText} characters`);
  if (!text.trim() && !extras?.files?.length) throw new Error('Write something or add a file');
}

/**
 * What a direct message with only files says to Macs that don't know about files (they need some
 * text): "📎 deck.pdf". Newer Macs see the files and drop the note.
 */
export const filesNote = (files: ReadonlyArray<{ readonly name: string }>): string => `📎 ${files.map((f) => f.name).join(', ')}`.slice(0, 500);

/** Does this call for Claudes include `peerId`'s? */
export const asks = (x: ChatExtras | undefined, peerId: string): boolean => Boolean(x?.ask && (x.ask.to === 'all' || x.ask.to.includes(peerId)));
