/**
 * "@ata" and "@claude:ata" are two different things (docs/agent-to-agent.md): "@ata" is Ata, the
 * person, who is told you mentioned them; "@claude:ata" is Ata's Claude, which your Claude asks
 * (ask_person). Your Claude may still decide on its own to ask a friend's Claude when the work needs
 * their Mac, under the usual "Ask Ata's Claude?" check.
 */

/** How a friend's name is written after "@" (as the message box completes it: src/ui/suggest.ts friendMention). */
const handle = (name: string): string => name.replace(/[^\p{L}\p{N}_.-]+/gu, '').toLowerCase();

const TOKEN = /(^|[\s({"'“])@([\p{L}\p{N}_][\p{L}\p{N}_.:/+-]*)/gu;
const TRAILING = /[.,;:!?)\]}"'”]+$/u;
/** Code (fenced or `inline`) mentions nobody. */
const withoutCode = (text: string): string => text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');

export interface Named {
  readonly peerId: string;
  readonly name: string;
}

/** The friends the words mention as people ("@ata", not "@claude:ata"), each once, in order. */
export function personMentions(text: string, friends: readonly Named[]): Named[] {
  const out = new Map<string, Named>();
  for (const m of withoutCode(text).matchAll(TOKEN)) {
    const token = (m[2] ?? '').replace(TRAILING, '').toLowerCase();
    if (!token || token === 'claude' || token === 'claudes' || token.startsWith('claude:')) continue;
    const friend = friends.find((f) => handle(f.name) === token);
    if (friend && !out.has(friend.peerId)) out.set(friend.peerId, friend);
  }
  return [...out.values()];
}

/** The friends whose Claude the words name ("@claude:ata"), each once, in order. */
export function claudeMentions(text: string, friends: readonly Named[]): Named[] {
  const out = new Map<string, Named>();
  for (const m of withoutCode(text).matchAll(TOKEN)) {
    const named = /^claude:(.+)$/.exec((m[2] ?? '').replace(TRAILING, '').toLowerCase())?.[1];
    const friend = named ? friends.find((f) => handle(f.name) === named) : undefined;
    if (friend && !out.has(friend.peerId)) out.set(friend.peerId, friend);
  }
  return [...out.values()];
}

/** What the mentioned friend gets: who, where, and what you wrote (clipped), in words. */
export function mentionNote(me: string, where: string, text: string): string {
  const said = text.trim().length > 600 ? `${text.trim().slice(0, 600)}…` : text.trim();
  return `${me} mentioned you in ${where}:\n\n${said}`;
}
