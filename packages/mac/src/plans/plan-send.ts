/**
 * Sending a message from the plan chat: its "[image N]" references become links to the images
 * (klaud keeps them) and it goes to the plan's Claude. Resolves when it went; rejects with what to
 * say under the box otherwise. Retry sends the same words again: images are expanded each time,
 * so a message whose images failed goes out once, expanded.
 */

export interface PlanSendApi {
  readonly attachments: { expand(text: string, channel: string): Promise<string> };
  /** False (or a rejection) when it didn't go. */
  readonly session: { submit(text: string, opts: { channel: string }): Promise<boolean | void> };
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const hasImageRefs = (message: string): boolean => message.includes('[image ') && !message.startsWith('/');

export async function sendPlanMessage(api: PlanSendApi, message: string, channel: string): Promise<void> {
  let full = message;
  if (hasImageRefs(message)) {
    try {
      full = await api.attachments.expand(message, channel);
    } catch (err) {
      throw new Error(`Couldn't send the images: ${errorText(err)}`);
    }
  }
  let went: boolean | void;
  try {
    went = await api.session.submit(full, { channel });
  } catch (err) {
    throw new Error(errorText(err));
  }
  if (went === false) throw new Error("Claude can't be asked here");
}
