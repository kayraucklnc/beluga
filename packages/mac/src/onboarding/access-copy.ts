import type { IconName } from '../components/Icon.js';
import type { Grant, PrivacyPane } from '../lib/privacy-model.js';
import type { AccessStep } from './onboarding-model.js';

/**
 * The permission steps' words: what each lets Claude do, in one sentence, and where it lives in
 * System Settings. Every one is optional; nothing in Beluga stops working without it.
 */
export interface AccessCopy {
  readonly pane: PrivacyPane;
  readonly icon: IconName;
  /** As System Settings names it. */
  readonly name: string;
  readonly title: string;
  /** Why it may be useful, in one sentence. */
  readonly why: string;
  /** What happens without it. */
  readonly without: string;
  /** What to do once System Settings is open. */
  readonly how: string;
}

export const ACCESS_COPY: Readonly<Record<AccessStep, AccessCopy>> = {
  screen: {
    pane: 'screen',
    icon: 'eye',
    name: 'Screen Recording',
    title: 'Let Claude see your screen.',
    why: 'Claude can take a screenshot of your screen or one app’s window when it needs to see what you see, like a page it just changed.',
    without: 'Without it, screenshots don’t work. Everything else does.',
    how: 'Turn on Beluga in the list. macOS may ask you to reopen Beluga.',
  },
  accessibility: {
    pane: 'accessibility',
    icon: 'hand',
    name: 'Accessibility',
    title: 'Let Claude use your other apps.',
    why: 'With it, Claude can click, type and read the controls in other apps for you when a task needs more than the terminal.',
    without: 'Without it, Claude stays in your worktrees and the terminal.',
    how: 'Turn on Beluga in the list.',
  },
  disk: {
    pane: 'disk',
    icon: 'folder',
    name: 'Full Disk Access',
    title: 'Fewer “allow access” prompts.',
    why: 'Claude can open projects in Documents, Desktop or iCloud Drive without macOS asking each time, and Beluga can tell when a Focus is holding its notifications.',
    without: 'Without it, macOS asks the first time Claude opens a protected folder.',
    how: 'Turn on Beluga in the list, or add it with +.',
  },
  automation: {
    pane: 'automation',
    icon: 'wand',
    name: 'Automation',
    title: 'Let Claude work with Finder and friends.',
    why: 'Claude can ask apps like Finder, Safari or Music to do things through AppleScript, such as revealing a file or reading the open page.',
    without: 'Without it, macOS asks the first time Claude talks to an app.',
    how: 'Allow it when macOS asks. Each app Claude works with gets its own switch.',
  },
};

/** The step's main button: what pressing it does now. */
export function accessAction(grant: Grant | undefined): string {
  return grant === 'granted' ? 'Open System Settings' : 'Allow in System Settings';
}

/** The footer's button on a permission step: go on, or pass on this one. */
export const accessNext = (grant: Grant | undefined): 'Continue' | 'Not Now' => (grant === 'granted' ? 'Continue' : 'Not Now');

/** The line under the step's title: how it stands. */
export function grantText(grant: Grant | undefined, asked: boolean): string {
  if (grant === 'granted') return 'Allowed';
  if (grant === 'off') return asked ? 'Waiting for you in System Settings' : 'Not allowed yet';
  return asked ? 'Opened System Settings' : 'Optional';
}
