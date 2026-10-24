/**
 * "Your Mac" (BLG-47): one conversation with your own Claude that isn't tied to any project or
 * worktree, the same on the phone and the Mac (core/assistant). Browser-safe: the screens, the
 * phone's views and the daemon all name it by this channel.
 */
export const ASSISTANT_CHANNEL = 'mac:assistant';
export const ASSISTANT_TITLE = 'Your Mac';

export const isAssistant = (channel: string | undefined): boolean => channel === ASSISTANT_CHANNEL;
