/**
 * Sending a message from the plan chat: its "[image N]" references become links to the images
 * (klaud keeps them) and it goes to the plan's Claude. Resolves when it went; rejects with what to
 * say under the box otherwise. Retry sends the same message again: its images are expanded once
 * (the first time that works), and it carries one id, so a Retry of a message that reached klaud
 * though its answer was lost isn't said in the chat, or asked of Claude, twice.
 */

export interface PlanSendApi {
  readonly attachments: { expand(text: string, channel: string): Promise<string> };
  /** False (or a rejection) when it didn't go. */
  readonly session: { submit(text: string, opts: { channel: string; id: string }): Promise<boolean | void> };
}

/** One message from the box, kept as is for Retry. */
export interface PlanMessage {
  readonly typed: string;
  readonly id: string;
  /** What it says with its images expanded, once they were. */
  expanded?: string;
}

export const planMessage = (typed: string): PlanMessage => ({ typed, id: crypto.randomUUID() });

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const hasImageRefs = (message: string): boolean => message.includes('[image ') && !message.startsWith('/');

export async function sendPlanMessage(api: PlanSendApi, message: PlanMessage, channel: string): Promise<void> {
  if (message.expanded === undefined) {
    let full = message.typed;
    if (hasImageRefs(full)) {
      try {
        full = await api.attachments.expand(full, channel);
      } catch (err) {
        throw new Error(`Couldn't send the images: ${errorText(err)}`);
      }
    }
    message.expanded = full;
  }
  let went: boolean | void;
  try {
    went = await api.session.submit(message.expanded, { channel, id: message.id });
  } catch (err) {
    throw new Error(errorText(err));
  }
  if (went === false) throw new Error("Claude can't be asked here");
}
