import { forkSession, getSessionMessages, type SessionMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Claude's side of editing a message you sent (BLG-385): a copy of its session that ends just
 * before that message, so it remembers what came before and nothing after. The session itself
 * is left as it was (a fork of it may still need it).
 */

/** What a prompt said, in the words of a user message (a string, or text blocks). */
function textOf(message: SessionMessage): string {
  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : '')).join('\n');
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Where `prompt` is in the session's messages: by its id (the message's request id, kept as the
 * prompt's uuid), else (sent before ids were kept) the last of your prompts that has its words.
 */
export function findPrompt(messages: readonly SessionMessage[], prompt: { readonly id?: string | undefined; readonly text: string }): number {
  if (prompt.id) {
    const i = messages.findIndex((m) => m.uuid === prompt.id);
    if (i >= 0) return i;
  }
  const words = squash(prompt.text).slice(0, 400);
  if (!words) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.type === 'user' && m.parent_tool_use_id === null && squash(textOf(m)).includes(words)) return i;
  }
  return -1;
}

/**
 * A session to go on from, just before `prompt`: a new one ending at the message before it, or
 * `sessionId: undefined` when it was the first (Claude starts fresh). Undefined when the prompt
 * can't be found in it (compacted away, or the session is gone).
 */
export async function sessionBefore(sessionId: string, dir: string, prompt: { readonly id?: string | undefined; readonly text: string }): Promise<{ readonly sessionId: string | undefined } | undefined> {
  const messages = await getSessionMessages(sessionId, { dir }).catch(() => [] as SessionMessage[]);
  const at = findPrompt(messages, prompt);
  if (at < 0) return undefined;
  if (at === 0) return { sessionId: undefined };
  const forked = await forkSession(sessionId, { dir, upToMessageId: messages[at - 1]!.uuid }).catch(() => undefined);
  return forked ? { sessionId: forked.sessionId } : undefined;
}
