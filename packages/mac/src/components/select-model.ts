/**
 * The logic behind Klaud's pop-up button (components/Select.tsx), kept free of React and the DOM
 * so it's tested on its own: which rows a menu shows, filtering, moving through the options with
 * the keyboard, type-ahead and where the menu opens.
 */

/** One choice. `label` is what's shown, searched and typed ahead to; it names the option for VoiceOver. */
export interface SelectOptionBase<T extends string> {
  readonly value: T;
  readonly label: string;
  /** A second line under the label (what the choice means). Searched too, when it's text. */
  readonly description?: string;
  /** More words the search field matches (a branch's remote, a font's family…). */
  readonly keywords?: readonly string[];
  readonly disabled?: boolean;
}

/** A titled section of options; sections are separated by a line. */
export interface SelectSectionBase<O> {
  readonly section: string;
  readonly options: readonly O[];
}

export type SelectEntryBase<O> = O | SelectSectionBase<O>;

/** A row in the open menu. `index` counts options only (what the keyboard moves through). */
export type SelectRow<O> = { readonly kind: 'option'; readonly option: O; readonly index: number } | { readonly kind: 'header'; readonly label: string; readonly key: string } | { readonly kind: 'separator'; readonly key: string };

/** Lists longer than this get a search field (branches, fonts). */
export const SEARCH_THRESHOLD = 10;

export const isSection = <O>(entry: SelectEntryBase<O>): entry is SelectSectionBase<O> => typeof entry === 'object' && entry !== null && 'section' in entry && 'options' in entry;

/** Every option in order, sections flattened. */
export function flatOptions<O>(entries: readonly SelectEntryBase<O>[]): O[] {
  return entries.flatMap((e) => (isSection(e) ? [...e.options] : [e]));
}

/** The menu's rows: headers for sections and a separator between a section and what's around it. */
export function menuRows<O>(entries: readonly SelectEntryBase<O>[]): SelectRow<O>[] {
  const rows: SelectRow<O>[] = [];
  let index = 0;
  entries.forEach((entry, at) => {
    if (isSection(entry)) {
      if (!entry.options.length) return;
      if (rows.length) rows.push({ kind: 'separator', key: `sep-${at}` });
      if (entry.section) rows.push({ kind: 'header', label: entry.section, key: `head-${at}` });
      for (const option of entry.options) rows.push({ kind: 'option', option, index: index++ });
      return;
    }
    // A loose option right after a section starts a new block.
    const prev = entries[at - 1];
    if (prev !== undefined && isSection(prev) && prev.options.length) rows.push({ kind: 'separator', key: `sep-${at}` });
    rows.push({ kind: 'option', option: entry, index: index++ });
  });
  return rows;
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Does this option match what's typed in the search field? Every word has to appear somewhere. */
export function matches<T extends string>(option: SelectOptionBase<T>, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([option.label, option.value, option.description ?? '', ...(option.keywords ?? [])].join(' '));
  return words.every((w) => hay.includes(w));
}

/** The entries left after a search: sections keep their title when anything in them matches. */
export function filterEntries<T extends string, O extends SelectOptionBase<T>>(entries: readonly SelectEntryBase<O>[], query: string): SelectEntryBase<O>[] {
  if (!query.trim()) return [...entries];
  return entries.flatMap((e): SelectEntryBase<O>[] => {
    if (!isSection(e)) return matches(e, query) ? [e] : [];
    const options = e.options.filter((o) => matches(o, query));
    return options.length ? [{ ...e, options }] : [];
  });
}

/** Should this list have a search field? `searchable` forces it either way. */
export const wantsSearch = (count: number, searchable?: boolean): boolean => searchable ?? count > SEARCH_THRESHOLD;

const enabled = <O extends { readonly disabled?: boolean }>(options: readonly O[], i: number): boolean => i >= 0 && i < options.length && !options[i]!.disabled;

/** The first option you can pick from `from` going `step` (±1), or -1. */
export function firstEnabled<O extends { readonly disabled?: boolean }>(options: readonly O[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < options.length; i += step) if (enabled(options, i)) return i;
  return -1;
}

export type MoveKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp';

/** Rows a PageUp / PageDown jumps. */
export const PAGE = 10;

/**
 * Where a key moves the highlight. Like a Mac menu it stops at the ends (no wrapping) and skips
 * options you can't pick. Nothing highlighted yet: ↓ starts at the top, ↑ at the bottom.
 */
export function moveActive<O extends { readonly disabled?: boolean }>(options: readonly O[], active: number, key: MoveKey): number {
  const last = options.length - 1;
  if (last < 0) return -1;
  const stay = (i: number): number => (i < 0 ? active : i);
  switch (key) {
    case 'Home':
      return stay(firstEnabled(options, 0, 1));
    case 'End':
      return stay(firstEnabled(options, last, -1));
    case 'ArrowDown':
      return active < 0 ? firstEnabled(options, 0, 1) : stay(firstEnabled(options, active + 1, 1));
    case 'ArrowUp':
      return active < 0 ? firstEnabled(options, last, -1) : stay(firstEnabled(options, active - 1, -1));
    case 'PageDown': {
      const to = Math.min(last, Math.max(active, 0) + PAGE);
      const back = firstEnabled(options, to, -1);
      return back > active ? back : stay(firstEnabled(options, to, 1));
    }
    case 'PageUp': {
      const to = Math.max(0, (active < 0 ? last : active) - PAGE);
      const ahead = firstEnabled(options, to, 1);
      return ahead >= 0 && (active < 0 || ahead < active) ? ahead : stay(firstEnabled(options, to, -1));
    }
  }
}

/**
 * Type-ahead: the option whose label starts with what's been typed, looking after the current one
 * first. Typing the same letter again steps through the options starting with it.
 */
export function typeahead<T extends string>(options: readonly SelectOptionBase<T>[], typed: string, from: number): number {
  const query = fold(typed);
  if (!query || !options.length) return -1;
  const same = [...query].every((c) => c === query[0]);
  const needle = same ? query[0]! : query;
  // A fresh search (or a repeated letter) starts after the current option; a longer one includes it.
  const start = same || query.length === 1 ? from + 1 : Math.max(from, 0);
  for (let n = 0; n < options.length; n++) {
    const i = (((start + n) % options.length) + options.length) % options.length;
    const o = options[i]!;
    if (!o.disabled && fold(o.label).startsWith(needle)) return i;
  }
  return -1;
}

export interface Placement {
  /** 'over': the chosen option sits on the button (macOS); 'below': the menu drops under it. */
  readonly mode: 'over' | 'below';
  /** Distance from the button's bottom edge to the menu's top (negative when it covers the button). */
  readonly sideOffset: number;
}

export interface PlaceInput {
  readonly triggerTop: number;
  readonly triggerHeight: number;
  /** The whole menu's height, unscrolled. */
  readonly menuHeight: number;
  /** The chosen option's top inside the menu, and its height; undefined when nothing's chosen. */
  readonly selectedTop?: number;
  readonly selectedHeight?: number;
  readonly viewportHeight: number;
  /** Space to keep from the window's edges. */
  readonly margin?: number;
  /** A searchable list always drops below (the field stays where you look). */
  readonly search?: boolean;
  /** The gap under the button when the menu drops below. */
  readonly gap?: number;
}

/**
 * Where the menu opens: like a Mac pop-up button, with the chosen option right over the button
 * when the whole menu fits on screen that way; else below the button (Radix flips it up if
 * there's no room).
 */
export function placeMenu(p: PlaceInput): Placement {
  const margin = p.margin ?? 8;
  const below: Placement = { mode: 'below', sideOffset: p.gap ?? 4 };
  if (p.search || p.selectedTop === undefined || p.selectedHeight === undefined) return below;
  const top = p.triggerTop + p.triggerHeight / 2 - (p.selectedTop + p.selectedHeight / 2);
  const fits = top >= margin && top + p.menuHeight <= p.viewportHeight - margin;
  return fits ? { mode: 'over', sideOffset: Math.round(top - (p.triggerTop + p.triggerHeight)) } : below;
}
