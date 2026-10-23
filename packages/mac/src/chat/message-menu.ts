import type { LinkedImage } from '@beluga/shared/attachment-links.js';
import type { ActionItem } from '../components/SpecMenu.js';
import { copyText } from '../lib/copy.js';
import type { UiStore } from '../lib/beluga.js';

/**
 * What right-clicking a message offers: copy it (as you read it, or as Markdown), quote it in
 * your reply, ask Claude about it, open its pictures. Built when the menu opens.
 */

const QUOTE_MAX = 1500;

/** Markdown as the words you read (no **, `, # or link targets). */
export function plainText(md: string): string {
  return md
    .replace(/^```[^\n]*\n?/gm, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .trim();
}

/** The text as a quote ("> " on every line), cut short if it's long. */
export function quoted(text: string): string {
  const body = text.length > QUOTE_MAX ? `${text.slice(0, QUOTE_MAX).trimEnd()}…` : text;
  return body
    .split('\n')
    .map((l) => (l ? `> ${l}` : '>'))
    .join('\n');
}

/** Put a quote in the message box, above what's already being typed, and focus it. */
export function quoteInBox(ui: UiStore, text: string, prefix = ''): void {
  const current = ui.get().buffer.trim();
  const buffer = `${prefix}${quoted(text)}\n\n${current}`;
  const cursor = buffer.length - current.length;
  ui.patch({ focus: 'chat', buffer, cursor, suggestHidden: true });
  document.dispatchEvent(new CustomEvent('beluga:focus-composer'));
}

/**
 * What's selected on the page, if it's more than a word (Copy then copies just that, like any
 * Mac app; a right-click alone may select the word under it, which shouldn't shrink Copy).
 */
const selection = (): string => {
  const text = window.getSelection()?.toString().trim() ?? '';
  return /\s/.test(text) ? text : '';
};

export interface MessageMenuOptions {
  readonly ui: UiStore;
  /** The message's own text (Markdown). */
  readonly text: string;
  /** "Ask Claude About This" reaches your Claude with this mention (a group room); omitted: Quote already does. */
  readonly askPrefix?: string;
  readonly images?: readonly LinkedImage[];
  readonly openImage?: (image: LinkedImage) => void;
  /** Extra items first (Stop on a running answer). */
  readonly lead?: readonly ActionItem[];
  readonly toast: (text: string) => void;
}

export function messageItems(o: MessageMenuOptions): ActionItem[] {
  const copy = (text: string, what: string): void => {
    copyText(text).then(
      () => o.toast(`Copied ${what}`),
      () => o.toast("Couldn't copy"),
    );
  };
  const hasText = Boolean(o.text.trim());
  const picked = selection();
  return [
    ...(o.lead ?? []),
    ...(hasText
      ? [
          { label: picked ? 'Copy Selection' : 'Copy', icon: 'copy' as const, ...(picked ? { keys: '⌘C' } : {}), separate: Boolean(o.lead?.length), onSelect: () => copy(picked || plainText(o.text), picked ? 'the selection' : 'the message') },
          { label: 'Copy as Markdown', onSelect: () => copy(o.text, 'as Markdown') },
          { label: 'Quote in Reply', icon: 'chat' as const, separate: true, onSelect: () => quoteInBox(o.ui, picked || o.text) },
          ...(o.askPrefix !== undefined ? [{ label: 'Ask Claude About This', icon: 'claude' as const, onSelect: () => quoteInBox(o.ui, picked || o.text, o.askPrefix) }] : []),
        ]
      : []),
    ...(o.images ?? []).map((img, i) => ({ label: o.images!.length > 1 ? `Open ${img.label}` : 'Open Image', icon: 'image' as const, separate: i === 0 && hasText, onSelect: () => o.openImage?.(img) })),
  ];
}
