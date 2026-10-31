/** A side question about a conversation (/btw): answered beside it, never part of it. */
export interface BtwRequest {
  readonly question: string;
  /** The conversation's folder. */
  readonly cwd: string;
  /** Its Claude session, when it has one: the answer forks it, so it knows everything said so far. */
  readonly resume?: string;
  readonly model?: string;
  /** The runtime the conversation runs on (unset: your default agent's): its session is that runtime's. */
  readonly runtime?: string;
  readonly signal: AbortSignal;
  /** The answer so far, as Claude writes it. */
  readonly onText: (soFar: string) => void;
}

/** What Claude is told around the question (Claude Code's /btw says much the same). */
export function btwPrompt(question: string): string {
  return [
    '<system-reminder>',
    'This is a side question from the user, asked while the main work goes on. Answer it directly and briefly, in one reply, from what you already know of this conversation and the code you have seen.',
    'You have no tools here and nothing you write is kept: don’t start, continue or promise any work, and don’t say you will look something up. If you can’t tell from what you know, say so in a sentence.',
    '</system-reminder>',
    '',
    question.trim(),
  ].join('\n');
}
