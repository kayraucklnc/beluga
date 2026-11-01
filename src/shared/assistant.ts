/**
 * "Your Mac" (BLG-47): your own Claude that isn't tied to any project or worktree, the same on the
 * phone and the Mac (core/assistant). Since BLG-102 it holds several chats, shown as tabs on the
 * Mac: each its own conversation (channel) and Claude session, deletable for good. Browser-safe:
 * the screens, the phone's views and the daemon all name them by these channels.
 */
export const ASSISTANT_CHANNEL = 'mac:assistant';

/** Which kind of computer Beluga runs on (its channels keep saying `mac:` everywhere). */
export type ComputerKind = 'mac' | 'windows' | 'linux';

/** A platform as Node or a browser says it ("darwin", "win32", "MacIntel", "Linux x86_64") → its kind. */
export const computerKindOf = (platform: string): ComputerKind => (/win/i.test(platform) && !/darwin/i.test(platform) ? 'windows' : /linux|x11|cros/i.test(platform) ? 'linux' : 'mac');

/**
 * The computer this runs on: the window's in the app, the process's in the daemon.
 * $BELUGA_COMPUTER picks one (the tests are a Mac's wherever they run).
 */
function computerHere(): ComputerKind {
  const set = typeof process !== 'undefined' ? process.env?.BELUGA_COMPUTER : undefined;
  if (set === 'mac' || set === 'windows' || set === 'linux') return set;
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined') return computerKindOf(`${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`);
  return typeof process !== 'undefined' ? computerKindOf(process.platform) : 'mac';
}

export const COMPUTER: ComputerKind = computerHere();

/** Your own Claude's name for this computer: "Your Mac", "Your Linux", "Your Windows". */
export const assistantTitleFor = (kind: ComputerKind): string => (kind === 'windows' ? 'Your Windows' : kind === 'linux' ? 'Your Linux' : 'Your Mac');
export const ASSISTANT_TITLE = assistantTitleFor(COMPUTER);

/** The computer in a sentence: "this Mac", "this PC", "this computer". */
export const THIS_COMPUTER = COMPUTER === 'windows' ? 'this PC' : COMPUTER === 'linux' ? 'this computer' : 'this Mac';

/** The first chat: the one conversation there was before BLG-102, keeping its channel `mac:assistant`. */
export const FIRST_CHAT = 'main';

/** A chat's id: short, lowercase letters and digits (it's part of the channel and of a folder's name). */
export const CHAT_ID = /^[a-z0-9]{1,24}$/;

/** A chat's channel: `mac:assistant` for the first, `mac:assistant:<id>` for the others. */
export const assistantChannel = (chat: string): string => (chat === FIRST_CHAT ? ASSISTANT_CHANNEL : `${ASSISTANT_CHANNEL}:${chat}`);

/** The chat a channel is, if it's one of Your Mac's. */
export function assistantChatOf(channel: string | undefined): string | undefined {
  if (channel === ASSISTANT_CHANNEL) return FIRST_CHAT;
  if (!channel?.startsWith(`${ASSISTANT_CHANNEL}:`)) return undefined;
  const id = channel.slice(ASSISTANT_CHANNEL.length + 1);
  return CHAT_ID.test(id) && id !== FIRST_CHAT ? id : undefined;
}

export const isAssistant = (channel: string | undefined): boolean => assistantChatOf(channel) !== undefined;

/** One of Your Mac's chats, as the screens see it. */
export interface AssistantChat {
  readonly id: string;
  readonly channel: string;
  readonly createdAt: number;
}

/** Your Mac's chats, in tab order, and the one open (persisted in ~/.beluga/assistant/chats.json). */
export interface AssistantChats {
  readonly chats: readonly AssistantChat[];
  readonly active: string;
}

export const NO_ASSISTANT_CHATS: AssistantChats = { chats: [], active: FIRST_CHAT };

/** The channel of the chat open now (the first chat's when there are none yet). */
export const activeAssistantChannel = (a: AssistantChats): string => a.chats.find((c) => c.id === a.active)?.channel ?? a.chats[0]?.channel ?? ASSISTANT_CHANNEL;

/** A chat's tab name: the first line you wrote in it, short; "New chat" until then. */
export function assistantChatTitle(channel: string, log: ReadonlyArray<{ readonly channel: string; readonly type: string; readonly byAgent?: boolean; readonly text?: string }>, max = 28): string {
  const first = log.find((l) => l.channel === channel && l.type === 'chat' && !l.byAgent && l.text?.trim());
  const line = first?.text?.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!line) return 'New chat';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
