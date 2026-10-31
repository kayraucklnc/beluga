/**
 * Every keyboard shortcut the Mac app has (BLG-289), the parts without a window so they can be
 * tested: what each does, its keys out of the box, where it works, which menu-bar item shows it,
 * how a key press reads as a chord, and what clashes with what when you change one.
 *
 * A chord is written "Ctrl+Alt+Shift+Cmd+K": the modifiers in that order, then the key. A key is
 * a capital letter or digit, a character ("." "[" "Ç"), or a name (Up, Tab, Enter, F5…).
 */

export type ShortcutScope =
  /** Anywhere in the window. */
  | 'app'
  /** On a page that has it (Tasks, Plans, Sentinel, a task's page…), not while typing. */
  | 'page'
  /** In the message box. */
  | 'composer'
  /** While a request waits for you, not while typing. */
  | 'approval'
  /** On a project in the sidebar. */
  | 'sidebar';

export type ShortcutSection = 'General' | 'View' | 'Go' | 'Conversation' | 'Workspace' | 'Message box' | 'Pages' | 'Requests' | 'Sidebar';

export interface ShortcutDef {
  readonly id: string;
  readonly label: string;
  readonly section: ShortcutSection;
  /** Its keys out of the box (none: you can give it one). */
  readonly keys: readonly string[];
  readonly scope: ShortcutScope;
  /** A word on where it works or what it does, under its name in Settings. */
  readonly hint?: string;
  /** The menu-bar item that shows its first key (its id in menu.rs). */
  readonly menu?: string;
  /** A key alone (no ⌘⌃⌥) is fine: it only works outside a field. */
  readonly bare?: boolean;
  /** Where both work, this one wins on purpose (a page's own New over New Chat): no clash. */
  readonly over?: readonly string[];
}

const def = (id: string, label: string, section: ShortcutSection, keys: readonly string[], more: Partial<Omit<ShortcutDef, 'id' | 'label' | 'section' | 'keys'>> = {}): ShortcutDef => ({ id, label, section, keys, scope: 'app', menu: id, ...more });

const PANEL = ['changes', 'files', 'terminal', 'info', 'history', 'scratch', 'background', 'phone'] as const;
const PANEL_NAMES: Record<(typeof PANEL)[number], string> = { changes: 'Changes', files: 'Files', terminal: 'Terminal', info: 'Info', history: 'History', scratch: 'Scratch', background: 'Background', phone: 'Phone' };

/** The talk shortcut (Settings › Voice) shows and clashes here too; it's kept in its own setting. */
export const TALK_ID = 'voice-talk';

export const SHORTCUTS: readonly ShortcutDef[] = [
  def('palette', 'Everything You Can Do…', 'General', ['Cmd+K']),
  def('settings', 'Settings…', 'General', ['Cmd+,']),
  def('help-keys', 'Keyboard Shortcuts', 'General', ['Cmd+/']),
  def('new-chat', 'New Chat', 'General', ['Cmd+N']),
  def('new-worktree', 'New Worktree…', 'General', ['Shift+Cmd+N']),
  def('add-project', 'Add Project…', 'General', ['Cmd+O']),
  def('invite', 'Invite…', 'General', ['Shift+Cmd+I']),
  def('find', 'Search Conversations', 'General', ['Shift+Cmd+F']),
  def('inbox', 'Inbox', 'General', ['Shift+Cmd+B']),
  def('paste-plain', 'Paste as Plain Text', 'General', ['Shift+Cmd+V']),
  { id: TALK_ID, label: 'Talk', section: 'General', keys: ['Alt+Space'], scope: 'app', hint: 'Hold it and speak (Settings › Voice)' },

  def('toggle-sidebar', 'Toggle Sidebar', 'View', ['Ctrl+Cmd+S']),
  def('toggle-inspector', 'Toggle Panel', 'View', ['Alt+Cmd+0', 'Alt+Cmd+I']),
  ...PANEL.map((tab, i) => def(`panel-${tab}`, `Show ${PANEL_NAMES[tab]}`, 'View', [`Alt+Cmd+${i + 1}`], { hint: 'in the right panel' })),
  def('toggle-dock', 'Toggle Terminal', 'View', ['Cmd+J']),
  def('zoom-in', 'Bigger Text', 'View', ['Cmd+=', 'Shift+Cmd+=']),
  def('zoom-out', 'Smaller Text', 'View', ['Cmd+-']),
  def('zoom-reset', 'Actual Size', 'View', ['Cmd+0']),

  def('go-overview', 'Overview', 'Go', ['Cmd+1']),
  def('go-tasks', 'Tasks', 'Go', ['Cmd+2']),
  def('go-room', 'Chat', 'Go', ['Cmd+3']),
  def('go-search', 'Search', 'Go', ['Cmd+4']),
  def('go-usage', 'Usage', 'Go', ['Cmd+5']),
  def('go-terminal', 'Terminal', 'Go', ['Cmd+6']),
  def('go-files', 'Shared Files', 'Go', ['Cmd+7']),
  def('go-issues', 'Issues', 'Go', []),
  def('go-actions', 'Actions', 'Go', []),
  def('go-sentinel', 'Sentinel', 'Go', []),
  def('go-dashboard', 'Dashboard', 'Go', []),
  { id: 'place-next', label: 'Next Place', section: 'Go', keys: ['Ctrl+Tab'], scope: 'app' },
  { id: 'place-prev', label: 'Previous Place', section: 'Go', keys: ['Ctrl+Shift+Tab'], scope: 'app' },
  def('ws-prev', 'Previous Workspace', 'Go', ['Alt+Cmd+Up']),
  def('ws-next', 'Next Workspace', 'Go', ['Alt+Cmd+Down']),

  def('conv-stop', 'Stop the Agent', 'Conversation', ['Cmd+.']),
  def('conv-plan', 'Plan First', 'Conversation', ['Alt+Cmd+P']),
  def('conv-find', 'Find…', 'Conversation', ['Cmd+F']),
  def('conv-find-next', 'Find Next', 'Conversation', ['Cmd+G']),
  def('conv-find-prev', 'Find Previous', 'Conversation', ['Shift+Cmd+G']),
  def('conv-terminal', 'Show as Terminal', 'Conversation', ['Shift+Cmd+T'], { hint: 'Your agent’s own terminal on the conversation, and back to the chat' }),
  def('conv-copy', 'Copy Last Answer', 'Conversation', []),
  def('conv-clear', 'Clear Conversation…', 'Conversation', ['Shift+Cmd+K']),

  def('ws-commit', 'Commit…', 'Workspace', ['Shift+Cmd+C']),
  def('ws-pr', 'Pull Request…', 'Workspace', ['Shift+Cmd+P']),
  def('ws-merge', 'Merge…', 'Workspace', ['Shift+Cmd+M']),
  def('ws-run', 'Run', 'Workspace', ['Cmd+R']),
  def('ws-review', 'Ask Your Agent to Review…', 'Workspace', ['Shift+Cmd+R']),
  def('ws-finder', 'Show in Finder', 'Workspace', []),
  def('ws-fork', 'Fork…', 'Workspace', []),
  def('ws-archive', 'Archive…', 'Workspace', ['Ctrl+Cmd+A']),

  { id: 'composer-steer', label: 'Steer', section: 'Message box', keys: ['Alt+Enter'], scope: 'composer', hint: 'The agent reads it at its next step' },
  { id: 'composer-send-now', label: 'Send Now', section: 'Message box', keys: ['Alt+Shift+Enter'], scope: 'composer', hint: 'Your steered message goes now; its step stops' },
  { id: 'composer-mode', label: 'Switch Acting and Planning', section: 'Message box', keys: ['Shift+Tab'], scope: 'composer' },

  { id: 'page-back', label: 'Back', section: 'Pages', keys: ['Cmd+['], scope: 'page', hint: 'From a task, an issue, a run or a sentinel' },
  { id: 'page-new', label: 'New Here', section: 'Pages', keys: ['Cmd+N', 'C'], scope: 'page', hint: 'A task in Tasks, a plan in Plans, a sentinel in Sentinel', bare: true, over: ['new-chat'] },
  { id: 'page-filter', label: 'Filter', section: 'Pages', keys: ['Cmd+F'], scope: 'page', hint: 'In Tasks and Sentinel', over: ['conv-find'] },

  { id: 'approve-yes', label: 'Approve', section: 'Requests', keys: ['Ctrl+Y'], scope: 'approval', hint: 'The request waiting for you' },
  { id: 'approve-no', label: 'Decline', section: 'Requests', keys: ['Ctrl+N'], scope: 'approval' },
  { id: 'approve-always', label: 'Always Allow', section: 'Requests', keys: ['Ctrl+A'], scope: 'approval' },

  { id: 'project-up', label: 'Move Project Up', section: 'Sidebar', keys: ['Ctrl+Cmd+Up'], scope: 'sidebar' },
  { id: 'project-down', label: 'Move Project Down', section: 'Sidebar', keys: ['Ctrl+Cmd+Down'], scope: 'sidebar' },
];

export const SECTIONS: readonly ShortcutSection[] = ['General', 'View', 'Go', 'Conversation', 'Workspace', 'Message box', 'Pages', 'Requests', 'Sidebar'];

const BY_ID = new Map(SHORTCUTS.map((d) => [d.id, d]));
export const shortcutDef = (id: string): ShortcutDef | undefined => BY_ID.get(id);

/** What macOS (or every Mac app) keeps for itself: never given to a shortcut. */
export const BUILT_IN: ReadonlyArray<readonly [string, string]> = [
  ['Cmd+Q', 'Quit Beluga'],
  ['Cmd+W', 'Close Window'],
  ['Cmd+H', 'Hide Beluga'],
  ['Alt+Cmd+H', 'Hide Others'],
  ['Cmd+M', 'Minimize'],
  ['Cmd+Z', 'Undo'],
  ['Shift+Cmd+Z', 'Redo'],
  ['Cmd+X', 'Cut'],
  ['Cmd+C', 'Copy'],
  ['Cmd+V', 'Paste'],
  ['Cmd+A', 'Select All'],
  ['Ctrl+Cmd+F', 'Full Screen'],
  ['Cmd+Tab', 'Switch Apps'],
  ['Cmd+Space', 'Spotlight'],
  ['Cmd+`', 'Switch Windows'],
  ['Ctrl+Cmd+Q', 'Lock Screen'],
  ['Shift+Cmd+3', 'Screenshot'],
  ['Shift+Cmd+4', 'Screenshot'],
  ['Shift+Cmd+5', 'Screenshot'],
];

/* ---------- Chords ---------- */

export interface Chord {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly cmd: boolean;
  readonly key: string;
}

const MODS = ['Ctrl', 'Alt', 'Shift', 'Cmd'] as const;

export function parseChord(s: string): Chord | undefined {
  if (!s) return undefined;
  // The key is what follows the last "+", or "+" itself ("Cmd++").
  const plus = s.endsWith('+') ? s.length - 1 : s.lastIndexOf('+');
  const key = s.endsWith('+') ? '+' : s.slice(plus + 1);
  const mods = plus > 0 ? s.slice(0, s.endsWith('+') ? plus - 1 : plus).split('+') : [];
  if (!key) return undefined;
  const c = { ctrl: false, alt: false, shift: false, cmd: false };
  for (const m of mods) {
    const k = m.toLowerCase() as keyof typeof c;
    if (!(k in c)) return undefined;
    c[k] = true;
  }
  return { ...c, key };
}

export const chordText = (c: Chord): string => [...MODS.filter((m) => c[m.toLowerCase() as 'ctrl']), c.key].join('+');

/** The same chord written one way ("cmd+shift+k" → "Shift+Cmd+K"). */
export const normalChord = (s: string): string | undefined => {
  const c = parseChord(s);
  return c ? chordText({ ...c, key: c.key.length === 1 ? c.key.toUpperCase() : c.key }) : undefined;
};

const NAMED_KEYS: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Spacebar: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };
const CODE_CHARS: Record<string, string> = { Period: '.', Comma: ',', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`', Minus: '-', Equal: '=', Space: 'Space', Enter: 'Enter', NumpadEnter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Escape: 'Escape', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown' };

/** The key a physical key is, as a US keyboard prints it (KeyG → G, Period → .). */
export function keyFromCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (code.startsWith('Arrow')) return NAMED_KEYS[code];
  return CODE_CHARS[code];
}

/** The key the character says (what your layout prints: "." on a Turkish keyboard too). */
export function keyFromChar(key: string): string | undefined {
  if (NAMED_KEYS[key]) return NAMED_KEYS[key];
  if (/^F\d{1,2}$/.test(key)) return key;
  // One printable character (a code point, so "Ç" counts), never a dead key or a control one.
  if ([...key].length !== 1 || /[\p{C}]/u.test(key)) return undefined;
  return key.toUpperCase();
}

export interface KeyPress {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export const isModifierOnly = (e: Pick<KeyPress, 'key' | 'code'>): boolean => /^(Meta|Control|Alt|Shift|OS|CapsLock|Fn)(Left|Right)?$/.test(e.code) || ['Meta', 'Control', 'Alt', 'Shift', 'CapsLock', 'Fn', 'OS'].includes(e.key) || (!e.code && !e.key);

/**
 * How a key press reads, first the way it's written down when recorded, then the other way.
 * Without ⌥ or ⇧ it's the character your layout prints (⌘. is ⌘. on any keyboard); with them it's
 * the physical key (⌥ and ⇧ change the character: ⌥P types π, ⇧= types +).
 */
export function chordsOf(e: KeyPress): string[] {
  if (isModifierOnly(e)) return [];
  const byChar = keyFromChar(e.key);
  const byCode = keyFromCode(e.code);
  const order = e.altKey || e.shiftKey ? [byCode, byChar] : [byChar, byCode];
  const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, cmd: e.metaKey };
  return [...new Set(order.filter((k): k is string => !!k).map((key) => chordText({ ...mods, key })))];
}

/** The chord a key press records as. */
export const chordOf = (e: KeyPress): string | undefined => chordsOf(e)[0];

const KEY_GLYPHS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', Enter: '↩', Tab: '⇥', Backspace: '⌫', Delete: '⌦', Escape: 'esc', Space: 'Space', Home: '↖', End: '↘', PageUp: '⇞', PageDown: '⇟', '-': '−' };

/** A chord as a Mac shows it: ⌃⌥⇧⌘ then the key. */
export function chordLabel(s: string): string {
  const c = parseChord(s);
  if (!c) return s;
  return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.cmd ? '⌘' : ''}${KEY_GLYPHS[c.key] ?? c.key}`;
}

/** The modifiers held right now, for the recorder's live preview ("⌥⌘…"). */
export const heldLabel = (e: Pick<KeyPress, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string => `${e.ctrlKey ? '⌃' : ''}${e.altKey ? '⌥' : ''}${e.shiftKey ? '⇧' : ''}${e.metaKey ? '⌘' : ''}`;

const MENU_KEYS = new Set(['.', ',', '/', ';', "'", '[', ']', '\\', '`', '-', '=', 'Up', 'Down', 'Left', 'Right', 'Tab', 'Space', 'Enter', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown']);

/** A chord as the menu bar takes it (Tauri's accelerators), or undefined when it can't show it ("Ç"). */
export function menuAccel(s: string): string | undefined {
  const c = parseChord(s);
  if (!c) return undefined;
  if (!/^[A-Z0-9]$/.test(c.key) && !/^F\d{1,2}$/.test(c.key) && !MENU_KEYS.has(c.key)) return undefined;
  return [c.ctrl && 'Ctrl', c.alt && 'Alt', c.shift && 'Shift', c.cmd && 'CmdOrCtrl', c.key].filter(Boolean).join('+');
}

/** The talk shortcut's accelerator ("CommandOrControl+Shift+D", Settings › Voice) as a chord, and back. */
export function chordOfAccel(accel: string): string | undefined {
  if (!accel) return undefined;
  const parts = accel.split('+');
  const key = parts.pop()!;
  const c = { ctrl: false, alt: false, shift: false, cmd: false };
  for (const p of parts) {
    const m = p.toLowerCase();
    if (m === 'commandorcontrol' || m === 'cmdorctrl' || m === 'command' || m === 'cmd' || m === 'super' || m === 'meta') c.cmd = true;
    else if (m === 'control' || m === 'ctrl') c.ctrl = true;
    else if (m === 'alt' || m === 'option') c.alt = true;
    else if (m === 'shift') c.shift = true;
  }
  const k = keyFromCode(key) ?? keyFromCode(`Key${key}`) ?? keyFromCode(`Digit${key}`) ?? key;
  return chordText({ ...c, key: k });
}

const CHAR_CODES: Record<string, string> = Object.fromEntries(Object.entries(CODE_CHARS).filter(([, v]) => v.length === 1).map(([k, v]) => [v, k]));
const ARROWS: Record<string, string> = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight' };

export function accelOfChord(s: string): string | undefined {
  const c = parseChord(s);
  if (!c) return undefined;
  const key = ARROWS[c.key] ?? CHAR_CODES[c.key] ?? c.key;
  return [c.cmd && 'CommandOrControl', c.ctrl && 'Control', c.alt && 'Alt', c.shift && 'Shift', key].filter(Boolean).join('+');
}

/* ---------- Your keys ---------- */

/** The keys you changed, by shortcut (an empty list: you took its keys away). */
export type ShortcutOverrides = Readonly<Record<string, readonly string[]>>;
export type Bindings = Readonly<Record<string, readonly string[]>>;

/** What a saved setting holds that still makes sense (unknown shortcuts and broken chords dropped). */
export function overridesOf(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(raw as Record<string, unknown>)) {
    if (!BY_ID.has(id) || id === TALK_ID || !Array.isArray(keys)) continue;
    out[id] = [...new Set(keys.filter((k): k is string => typeof k === 'string').map(normalChord).filter((k): k is string => !!k))];
  }
  return out;
}

/** Every shortcut's keys: yours where you changed them, the defaults elsewhere (and the talk shortcut). */
export function bindingsOf(overrides: ShortcutOverrides, talk?: string): Bindings {
  const out: Record<string, readonly string[]> = {};
  for (const d of SHORTCUTS) out[d.id] = d.id === TALK_ID ? (talk === undefined ? d.keys : talk ? [talk] : []) : (overrides[d.id] ?? d.keys);
  return out;
}

const sameKeys = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((k, i) => k === b[i]);
export const isChanged = (overrides: ShortcutOverrides, id: string): boolean => {
  const o = overrides[id];
  const d = BY_ID.get(id);
  return !!o && !!d && !sameKeys(o, d.keys);
};

/** Two shortcuts can be pressed in the same place (one works everywhere, or both in the same kind of place). */
function overlap(a: ShortcutDef, b: ShortcutDef): boolean {
  if (a.over?.includes(b.id) || b.over?.includes(a.id)) return false;
  // A request and the message box: the requests' keys wait while you type.
  if ((a.scope === 'approval' && b.scope === 'composer') || (b.scope === 'approval' && a.scope === 'composer')) return false;
  return a.scope === 'app' || b.scope === 'app' || a.scope === b.scope;
}

/** The shortcuts other than `id` that this chord would clash with. */
export function clashesWith(bindings: Bindings, id: string, chord: string): string[] {
  const me = BY_ID.get(id);
  if (!me) return [];
  return SHORTCUTS.filter((d) => d.id !== id && overlap(me, d) && (bindings[d.id] ?? []).includes(chord)).map((d) => d.id);
}

/** Every key two shortcuts share where both work (none, unless something went wrong). */
export function clashes(bindings: Bindings): Array<{ chord: string; ids: string[] }> {
  const out: Array<{ chord: string; ids: string[] }> = [];
  const seen = new Set<string>();
  for (const d of SHORTCUTS) {
    for (const chord of bindings[d.id] ?? []) {
      const others = clashesWith(bindings, d.id, chord);
      const key = [chord, d.id, ...others].sort().join('|');
      if (!others.length || seen.has(key)) continue;
      seen.add(key);
      out.push({ chord, ids: [d.id, ...others] });
    }
  }
  return out;
}

/** What macOS keeps this chord for, if it does. */
export const builtInFor = (chord: string): string | undefined => BUILT_IN.find(([k]) => k === chord)?.[1];

/** Why this chord can't be a shortcut for `id` (undefined: it can). */
export function refusal(id: string, chord: string): string | undefined {
  const c = parseChord(chord);
  const d = BY_ID.get(id);
  if (!c || !d) return 'That isn’t a key';
  const taken = builtInFor(chord);
  if (taken) return `${chordLabel(chord)} is ${taken}: macOS keeps it`;
  if (c.key === 'Escape' && !c.cmd && !c.ctrl && !c.alt) return 'esc closes things: pick another key';
  // The talk shortcut is held down: ↩ and esc are what you press while it listens.
  if (id === TALK_ID && (c.key === 'Enter' || c.key === 'Escape')) return `${chordLabel(chord)} sends while you talk: pick another key`;
  const fn = /^F\d{1,2}$/.test(c.key);
  // ⌥ alone over a letter, digit or sign types a character on many keyboards (⌥3 is # on a British
  // or Turkish Mac, ⌥L is @ on a German one), and the menu bar would take it from every text box.
  if (c.alt && !c.cmd && !c.ctrl && [...c.key].length === 1) return `${chordLabel(chord)} types a character on some keyboards: add ⌘ or ⌃`;
  if (c.cmd || c.ctrl || c.alt || fn) return undefined;
  if (d.scope === 'composer' && c.shift && (c.key === 'Enter' || c.key === 'Tab')) return undefined;
  if (d.bare && !c.shift) return undefined;
  return `${chordLabel(chord)} would type: add ⌘, ⌃ or ⌥`;
}

/** A gentle word about a chord that works, but not everywhere. */
export function caveat(id: string, chord: string): string | undefined {
  const c = parseChord(chord);
  const d = BY_ID.get(id);
  if (!c || !d) return undefined;
  // In a terminal, keys without ⌘ are the shell's (App.tsx); only ⌃Tab still moves places.
  if (!c.cmd && d.scope === 'app' && !(c.ctrl && c.key === 'Tab')) return `In a terminal, ${chordLabel(chord)} goes to the shell`;
  if (d.menu && !menuAccel(chord)) return 'The menu bar can’t show this key, but it works';
  return undefined;
}

export type AssignMode = 'replace' | 'swap';

/**
 * Give `id` this chord in place of its `slot`-th key (slot past the end: a new key), taking it
 * from whatever had it (replace) or handing that one your old key (swap). Returns the new overrides.
 */
export function assign(overrides: ShortcutOverrides, bindings: Bindings, id: string, slot: number, chord: string, mode: AssignMode = 'replace'): ShortcutOverrides {
  const mine = [...(bindings[id] ?? [])];
  const old = mine[slot];
  if (slot < mine.length) mine[slot] = chord;
  else mine.push(chord);
  let next: Record<string, readonly string[]> = { ...overrides, [id]: dedupe(mine) };
  for (const other of clashesWith(bindings, id, chord)) {
    const theirs = bindings[other] ?? [];
    const swapIn = mode === 'swap' && old && old !== chord && !clashesWith({ ...bindings, [id]: dedupe(mine) }, other, old).length;
    next = { ...next, [other]: dedupe(theirs.flatMap((k) => (k === chord ? (swapIn ? [old] : []) : [k]))) };
  }
  return tidy(next);
}

/** Take one key away from a shortcut. */
export function unassign(overrides: ShortcutOverrides, bindings: Bindings, id: string, slot: number): ShortcutOverrides {
  return tidy({ ...overrides, [id]: (bindings[id] ?? []).filter((_, i) => i !== slot) });
}

/** A shortcut back to its keys out of the box (and anything that took them gives them back). */
export function resetOne(overrides: ShortcutOverrides, id: string): ShortcutOverrides {
  const d = BY_ID.get(id);
  if (!d) return overrides;
  let next: Record<string, readonly string[]> = { ...overrides };
  delete next[id];
  const bindings = bindingsOf(next);
  for (const chord of d.keys) for (const other of clashesWith(bindings, id, chord)) next = { ...next, [other]: (next[other] ?? bindings[other] ?? []).filter((k) => k !== chord) };
  return tidy(next);
}

const dedupe = (keys: readonly string[]): string[] => [...new Set(keys)];

/**
 * Overrides that say the same as the defaults are dropped. The talk shortcut stays when it
 * changed: its home is Settings › Voice, so whoever saves takes it out and keeps it there.
 */
function tidy(o: Record<string, readonly string[]>): ShortcutOverrides {
  const out: Record<string, readonly string[]> = {};
  for (const [id, keys] of Object.entries(o)) if (id === TALK_ID || (BY_ID.has(id) && !sameKeys(keys, BY_ID.get(id)!.keys))) out[id] = keys;
  return out;
}

/* ---------- Pressing them ---------- */

/** Does this key press fire `id`? (Matching the way it's recorded first, then by the other reading.) */
export function pressed(bindings: Bindings, id: string, e: KeyPress): boolean {
  const keys = bindings[id] ?? [];
  if (!keys.length) return false;
  const [first, second] = chordsOf(e);
  if (first && keys.includes(first)) return true;
  // The other reading counts only when nothing else is this press the first way.
  if (!second || !keys.includes(second)) return false;
  return !SHORTCUTS.some((d) => d.id !== id && (bindings[d.id] ?? []).includes(first!));
}

/** The first of these shortcuts this key press fires. */
export function shortcutFor(bindings: Bindings, e: KeyPress, ids: Iterable<string>): string | undefined {
  const list = [...ids];
  const [first, second] = chordsOf(e);
  if (!first) return undefined;
  return list.find((id) => (bindings[id] ?? []).includes(first)) ?? (second ? list.find((id) => (bindings[id] ?? []).includes(second)) : undefined);
}

/** The keys a shortcut shows (its first), for tooltips and menus. */
export const keysLabel = (bindings: Bindings, id: string): string | undefined => {
  const k = bindings[id]?.[0];
  return k ? chordLabel(k) : undefined;
};

/** For the menu bar: each item's key (null: none). */
export function menuKeys(bindings: Bindings): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const d of SHORTCUTS) if (d.menu) out[d.menu] = (bindings[d.id] ?? []).map(menuAccel).find(Boolean) ?? null;
  return out;
}

/** Search shortcuts by name, section, hint or keys ("commit", "⇧⌘", "panel"). */
export function searchShortcuts(bindings: Bindings, q: string): ShortcutDef[] {
  const t = q.trim().toLowerCase();
  if (!t) return [...SHORTCUTS];
  return SHORTCUTS.filter((d) => `${d.label} ${d.section} ${d.hint ?? ''} ${(bindings[d.id] ?? []).map(chordLabel).join(' ')}`.toLowerCase().includes(t));
}
