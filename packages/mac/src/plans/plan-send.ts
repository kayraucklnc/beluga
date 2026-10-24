/**
 * Sending a message from the plan chat: its "[image N]" references become links to the images
 * (Beluga keeps them) and it goes to the plan's Claude. Resolves when it went; rejects with what to
 * say under the box otherwise. Retry sends the same message again: its images are expanded once
 * (the first time that works), and it carries one id, so a Retry of a message that reached Beluga
 * though its answer was lost isn't said in the chat, or asked of Claude, twice.
 */

export interface PlanSendApi {
  readonly attachments: { expand(text: string, channel: string, only?: number[]): Promise<string> };
  /** False (or a rejection) when it didn't go. */
  readonly session: { submit(text: string, opts: { channel: string; id: string; urgent?: boolean }): Promise<boolean | void> };
}

/** One message from the box, kept as is for Retry. */
export interface PlanMessage {
  readonly typed: string;
  readonly id: string;
  /** The images that went with it (only their "[image N]" become links). */
  readonly images?: readonly number[];
  /** What it says with its images expanded, once they were. */
  expanded?: string;
}

export const planMessage = (typed: string, images?: readonly number[]): PlanMessage => ({ typed, id: crypto.randomUUID(), ...(images ? { images } : {}) });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const hasImageRefs = (message: string): boolean => message.includes('[image ') && !message.startsWith('/');

/**
 * `urgent`: now, while Claude works (the plan's conversation is where you run everything from, so
 * by default your message doesn't wait behind a long turn): read at its next step, or a long
 * command is interrupted for it (the agent host's steer).
 */
export async function sendPlanMessage(api: PlanSendApi, message: PlanMessage, channel: string, urgent = false): Promise<void> {
  if (message.expanded === undefined) {
    let full = message.typed;
    if (hasImageRefs(full)) {
      try {
        full = await api.attachments.expand(full, channel, message.images && [...message.images]);
      } catch (err) {
        throw new Error(`Couldn't send the images: ${errorText(err)}`);
      }
    }
    message.expanded = full;
  }
  let went: boolean | void;
  try {
    went = await api.session.submit(message.expanded, { channel, id: message.id, ...(urgent ? { urgent: true } : {}) });
  } catch (err) {
    throw new Error(errorText(err));
  }
  if (went === false) throw new Error("Claude can't be asked here");
}
