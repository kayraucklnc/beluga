import { describe, expect, it } from 'vitest';
import { ghosttyAction, ghosttyChord, ghosttyKeys, itermChord, itermKeys, menuEquivalentChord } from '../src/terminal/import/keys.js';
import { ghosttyLines, parseGhostty } from '../src/terminal/import/parsers.js';
import { chipCells, imageHits, taskHits, visualHits } from '../packages/mac/src/lib/term-links.js';
import { AGENT_TAB, addTab, closePane, closeTab, firstTabs, gotoTab, nextPaneNumber, pane, paneKeys, resizeSplit, splitPane, stepTab, tabsOf, toggleZoom, treeOf, withTree } from '../packages/mac/src/lib/term-panes.js';
import { centerShows, clampBoth, convoModeOf, hasAgentTurn, sendsToTerminal, toggledMode, withConvoMode } from '../packages/mac/src/lib/convo-mode.js';
import { type AppState, initialState } from '../src/core/store.js';
import { TERM_BUSY, isTermBusy } from '../src/shared/terminal-keys.js';
import { DEFAULT_TERM_KEYS, actionLabel, termKeyFor, termKeyRows, termKeysOf } from '../packages/mac/src/lib/term-keys.js';
import { importPatch, importSummary, termKeysOf as savedKeys } from '../packages/mac/src/lib/terminal-import-model.js';
import { PRESET_FROM, TERMINAL_PRESETS, presetOf } from '../packages/mac/src/lib/terminal-themes.js';

/** BLG-535–537: links in the terminal, its tabs and splits, how a conversation shows, and keys from your own terminal. */

const press = (key: string, code: string, mods: { meta?: boolean; shift?: boolean; alt?: boolean; ctrl?: boolean } = {}) => ({ key, code, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl });

describe('links in the terminal', () => {
  it('finds visual tokens and the board’s task keys in a line', () => {
    expect(visualHits('  [[visual:12]]  and [[visual:3]]')).toEqual([
      { n: 12, start: 2, end: 15 },
      { n: 3, start: 21, end: 33 },
    ]);
    const has = (k: string) => k === 'BLG-12';
    expect(taskHits('I opened BLG-12 and task:BLG-12, not UTF-8 or src/BLG-12.ts or BLG-99', has)).toEqual([
      { key: 'BLG-12', start: 9, end: 15 },
      { key: 'BLG-12', start: 20, end: 31 },
    ]);
  });

  it('finds pictures by their absolute path', () => {
    expect(imageHits('I took /Users/me/.beluga/scratch/01-login.png, and (~/shots/a.jpeg).')).toEqual([
      { path: '/Users/me/.beluga/scratch/01-login.png', start: 7, end: 45 },
      { path: '~/shots/a.jpeg', start: 52, end: 66 },
    ]);
    expect(imageHits('src/logo.png is relative, http://x/y.png a URL')).toEqual([]);
  });

  it('lets a chip take the blank cells after its token, up to what it wants', () => {
    const text = '  [[visual:1]]';
    expect(chipCells(text, { start: 2, end: 14 }, 40, 120)).toBe(40);
    expect(chipCells(text, { start: 2, end: 14 }, 40, 30)).toBe(28);
    expect(chipCells('  [[visual:1]]   more', { start: 2, end: 14 }, 40, 120)).toBe(15);
    expect(chipCells(text, { start: 2, end: 14 }, 5, 120)).toBe(12);
  });
});

describe('panes and tabs', () => {
  it('splits, resizes and closes panes; the last one never goes', () => {
    let t = pane('a');
    t = splitPane(t, 'a', 'right', 'b');
    t = splitPane(t, 'b', 'down', 'c');
    expect(paneKeys(t)).toEqual(['a', 'b', 'c']);
    expect(splitPane(t, 'zz', 'right', 'd')).toBe(t);
    t = resizeSplit(t, '', 0.99);
    expect(t.kind === 'split' && t.ratio).toBe(0.85);
    t = closePane(t, 'b');
    expect(paneKeys(t)).toEqual(['a', 'c']);
    expect(closePane(pane('a'), 'a')).toEqual(pane('a'));
    expect(nextPaneNumber(['w:agent', 'w:pane:1', 'w:pane:3'])).toBe(2);
    expect(treeOf({ kind: 'split', dir: 'right', ratio: 0.3, a: { kind: 'pane', key: 'w:agent' }, b: { kind: 'pane', key: 'x' } }, 'w:agent')).toBeDefined();
    expect(treeOf({ kind: 'split', dir: 'sideways' }, 'w:agent')).toBeUndefined();
  });

  it('keeps the agent’s tab first and open; shell tabs come and go', () => {
    let t = firstTabs('w:agent');
    t = addTab(t, 'w:pane:1');
    t = addTab(t, 'w:pane:2');
    expect(t.tabs.map((x) => x.id)).toEqual([AGENT_TAB, 'tab:w:pane:1', 'tab:w:pane:2']);
    expect(t.active).toBe('tab:w:pane:2');
    expect(stepTab(t, 1).active).toBe(AGENT_TAB);
    expect(gotoTab(t, 2).active).toBe('tab:w:pane:1');
    expect(gotoTab(t, 9).active).toBe('tab:w:pane:2');
    expect(closeTab(t, AGENT_TAB)).toBe(t);
    t = closeTab(t, 'tab:w:pane:2');
    expect(t.active).toBe('tab:w:pane:1');
    t = withTree(t, 'tab:w:pane:1', splitPane(t.tabs[1]!.tree, 'w:pane:1', 'down', 'w:pane:3'));
    t = toggleZoom(t, 'tab:w:pane:1', 'w:pane:3');
    expect(t.tabs[1]!.zoom).toBe('w:pane:3');
    expect(toggleZoom(t, 'tab:w:pane:1', 'w:pane:3').tabs[1]!.zoom).toBeUndefined();
    // Saved and read back; broken saves fall back to the agent's tab alone.
    expect(tabsOf(JSON.parse(JSON.stringify(t)), 'w:agent')).toEqual({ ...t, tabs: t.tabs.map(({ id, tree }) => ({ id, tree })) });
    expect(tabsOf({ tabs: [{ id: 'tab:x', tree: { kind: 'pane', key: 'w:agent' } }] }, 'w:agent')).toEqual(firstTabs('w:agent'));
    expect(tabsOf('nonsense', 'w:agent')).toEqual(firstTabs('w:agent'));
  });
});

describe('how a conversation shows', () => {
  it('remembers each one’s mode, else the default', () => {
    expect(convoModeOf({}, 'chat', 'w1')).toBe('chat');
    const modes = withConvoMode({}, 'w1', 'terminal');
    expect(convoModeOf(modes, 'chat', 'w1')).toBe('terminal');
    expect(convoModeOf({ w1: 'bogus' } as never, 'both', 'w1')).toBe('both');
    expect(toggledMode('chat')).toBe('terminal');
    expect(toggledMode('both')).toBe('chat');
    expect(clampBoth(2)).toBe(0.6);
    expect(clampBoth(Number.NaN)).toBe(0.38);
  });

  it('starts as the chat until the first message opens the terminal, and waits on a turn in the chat (BLG-553)', () => {
    const fresh = { turnRunning: false, driving: false, started: false, picked: false };
    expect(centerShows('terminal', fresh)).toBe('fresh');
    expect(centerShows('both', fresh)).toBe('fresh');
    expect(centerShows('terminal', { ...fresh, started: true })).toBe('terminal');
    // Picked for it yourself: it opens at once.
    expect(centerShows('terminal', { ...fresh, picked: true })).toBe('terminal');
    expect(centerShows('terminal', { ...fresh, turnRunning: true, started: true })).toBe('waiting');
    expect(centerShows('both', { ...fresh, turnRunning: true })).toBe('waiting');
    // A terminal already driving stays, and the chat is the chat.
    expect(centerShows('terminal', { turnRunning: true, driving: true, started: false, picked: false })).toBe('terminal');
    expect(centerShows('chat', fresh)).toBe('chat');
  });

  it('sends a fresh conversation’s first message to its terminal, only when it shows as one', () => {
    const base = initialState('room', 'auto');
    const ws = { id: 'w1', kind: 'worktree', path: '/w' };
    const state = { ...base, projects: [{ id: 'p', root: '/p', workspaces: [ws] }] } as unknown as AppState;
    const prefs = { termView: true, convoModes: {}, convoDefault: 'terminal' as const };
    expect(sendsToTerminal(state, prefs, 'ws:w1')).toBe(true);
    expect(sendsToTerminal(state, { ...prefs, termView: false }, 'ws:w1')).toBe(false);
    expect(sendsToTerminal(state, { ...prefs, convoModes: { w1: 'chat' } }, 'ws:w1')).toBe(false);
    // Switched to Terminal by hand: it's open already, so the message is typed there, not handed.
    expect(sendsToTerminal(state, { ...prefs, convoModes: { w1: 'terminal' } }, 'ws:w1')).toBe(false);
    expect(sendsToTerminal(state, prefs, 'room')).toBe(false);
    // Once its agent has had a turn, a message is the terminal's own business (or the chat's).
    const started = { ...state, log: [{ id: 'a', type: 'agent', channel: 'ws:w1', status: 'done', text: 'hi', steps: [], subagents: [], ts: 1 }] } as unknown as AppState;
    expect(hasAgentTurn(started.log, 'ws:w1')).toBe(true);
    expect(sendsToTerminal(started, prefs, 'ws:w1')).toBe(false);
    // A new one, made with this message: on your default, not on Codex.
    expect(sendsToTerminal(state, prefs, 'draft')).toBe(true);
    expect(sendsToTerminal(state, prefs, 'draft', 'codex')).toBe(false);
    expect(sendsToTerminal(state, { ...prefs, convoDefault: 'chat' }, 'draft')).toBe(false);
  });

  it('knows a busy terminal from one that couldn’t start', () => {
    expect(isTermBusy(`Error: ${TERM_BUSY}`)).toBe(true);
    expect(isTermBusy('That workspace is archived or gone.')).toBe(false);
  });
});

describe('the terminal’s keys', () => {
  it('has iTerm2’s and Ghostty’s keys, and yours over them', () => {
    const keys = termKeysOf([{ chord: 'Cmd+T', action: 'unbind' }, { chord: 'Alt+Left', action: 'text:\x1bb' }, { chord: 'Cmd+D', action: 'split_down' }], 'Ghostty');
    expect(termKeyFor(keys, press('t', 'KeyT', { meta: true }))).toBeUndefined();
    expect(termKeyFor(keys, press('ArrowLeft', 'ArrowLeft', { alt: true }))).toMatchObject({ action: 'text:\x1bb', from: 'Ghostty' });
    expect(termKeyFor(keys, press('d', 'KeyD', { meta: true }))).toMatchObject({ action: 'split_down' });
    expect(termKeyFor(DEFAULT_TERM_KEYS, press('D', 'KeyD', { meta: true, shift: true }))).toMatchObject({ action: 'split_down' });
    expect(termKeyFor(DEFAULT_TERM_KEYS, press('3', 'Digit3', { meta: true }))).toMatchObject({ action: 'tab:3' });
    expect(termKeyFor(DEFAULT_TERM_KEYS, press('a', 'KeyA'))).toBeUndefined();
    expect(actionLabel('text:\x1bb')).toBe('Types Esc b');
    const rows = termKeyRows(keys);
    expect(rows.find((r) => r.label === 'Tab 1 to 9')).toBeDefined();
    expect(rows.find((r) => r.label === 'Types Esc b')).toMatchObject({ from: 'Ghostty' });
  });

  it('reads Ghostty’s keybinds', () => {
    expect(ghosttyChord('super+shift+d')).toBe('Shift+Cmd+D');
    expect(ghosttyChord('global:ctrl+alt+left')).toBe('Ctrl+Alt+Left');
    expect(ghosttyChord('ctrl+a>n')).toBeUndefined();
    expect(ghosttyChord('super+bracket_left')).toBe('Cmd+[');
    expect(ghosttyAction('new_split:down')).toBe('split_down');
    expect(ghosttyAction('goto_split:top')).toBe('focus_up');
    expect(ghosttyAction('text:\\x1bb')).toBe('text:\x1bb');
    expect(ghosttyAction('csi:A')).toBe('text:\x1b[A');
    expect(ghosttyAction('toggle_fullscreen')).toBeUndefined();
    const config = ['keybind = super+t=new_tab', 'keybind = super+t=unbind', 'keybind = alt+left=esc:b', 'keybind = super+enter=toggle_fullscreen', 'keybind = super+==increase_font_size:1', 'font-size = 14'].join('\n');
    const { keys, skipped } = ghosttyKeys(ghosttyLines(config));
    expect(keys).toEqual([
      { chord: 'Cmd+T', action: 'unbind' },
      { chord: 'Alt+Left', action: 'text:\x1bb' },
      { chord: 'Cmd+=', action: 'font_up' },
    ]);
    expect(skipped).toBe(1);
    const parsed = parseGhostty(config);
    expect(parsed.look?.keys).toHaveLength(3);
    expect(parsed.notes.join(' ')).toMatch(/One of your keys/);
  });

  it('reads iTerm2’s key mappings and menu shortcuts', () => {
    expect(itermChord('0xf702-0x280000')).toBe('Alt+Left');
    expect(itermChord('0x64-0x100000-0x2')).toBe('Cmd+D');
    expect(menuEquivalentChord('@$d')).toBe('Shift+Cmd+D');
    expect(menuEquivalentChord('@~')).toBe('Alt+Cmd+Right');
    const root = {
      GlobalKeyMap: { '0xf702-0x280000': { Action: 10, Text: 'b' }, '0x61-0x40000': { Action: 11, Text: '0x1 0x2' }, '0x71-0x100000': { Action: 99, Text: '' } },
      NSUserKeyEquivalents: { 'Split Vertically with Current Profile': '@e', 'Some Other Menu': '@j' },
    };
    const profile = { 'Keyboard Map': { '0xf703-0x280000': { Action: 12, Text: 'hi\\n' } } };
    const { keys, skipped } = itermKeys(root, profile);
    expect(keys).toEqual(
      expect.arrayContaining([
        { chord: 'Alt+Left', action: 'text:\x1bb' },
        { chord: 'Ctrl+A', action: 'text:\x01\x02' },
        { chord: 'Alt+Right', action: 'text:hi\n' },
        { chord: 'Cmd+E', action: 'split_right' },
      ]),
    );
    expect(skipped).toBe(2);
  });

  it('come over with an import, and are kept as they were', () => {
    const { patch } = importPatch({ keys: [{ chord: 'Cmd+E', action: 'split_right' }] }, 'iTerm2');
    expect(patch.termKeys).toEqual({ from: 'iTerm2', keys: [{ chord: 'Cmd+E', action: 'split_right' }] });
    expect(importSummary({ keys: [{ chord: 'Cmd+E', action: 'split_right' }] })).toContain('1 key (tabs, splits…)');
    expect(savedKeys({ from: 'Ghostty', keys: [{ chord: 'Cmd+T', action: 'new_tab' }, { nope: 1 }] })).toEqual({ from: 'Ghostty', keys: [{ chord: 'Cmd+T', action: 'new_tab' }] });
    expect(savedKeys('x')).toBeNull();
  });
});

describe('preset themes', () => {
  it('are whole themes (16 colours each), found again by name', () => {
    for (const p of TERMINAL_PRESETS) {
      expect(p.colors.ansi).toHaveLength(16);
      expect(p.colors.ansi.every((c) => /^#[0-9a-f]{6}$/.test(c ?? ''))).toBe(true);
      if (p.light) expect(p.light.ansi).toHaveLength(16);
    }
    expect(presetOf({ ...TERMINAL_PRESETS[0]!, from: PRESET_FROM })?.name).toBe('Dracula');
    expect(presetOf({ ...TERMINAL_PRESETS[0]!, from: 'Ghostty' })).toBeUndefined();
  });
});
