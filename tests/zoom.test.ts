import { describe, expect, it } from 'vitest';
import { detectTerminal, zoom, zoomCommand, zoomHelp } from '../src/core/zoom.js';
import { handleKey, initialUi } from '../src/ui/keymap.js';

describe('text size', () => {
  it('detects common terminals', () => {
    expect(detectTerminal({ TERM_PROGRAM: 'iTerm.app' }).id).toBe('iterm');
    expect(detectTerminal({ ITERM_SESSION_ID: 'x' }).id).toBe('iterm');
    expect(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }).id).toBe('apple');
    expect(detectTerminal({ TERM_PROGRAM: 'WarpTerminal' }).id).toBe('warp');
    expect(detectTerminal({ KITTY_WINDOW_ID: '1' }).id).toBe('kitty');
    expect(detectTerminal({ ALACRITTY_SOCKET: 's' }).id).toBe('alacritty');
    expect(detectTerminal({ TERM_PROGRAM: 'WezTerm' }).id).toBe('wezterm');
    expect(detectTerminal({ GHOSTTY_RESOURCES_DIR: '/x' }).id).toBe('ghostty');
    expect(detectTerminal({ TERM_PROGRAM: 'vscode' }).id).toBe('vscode');
    expect(detectTerminal({}).id).toBe('unknown');
  });

  it('builds the right command per terminal', () => {
    expect(zoomCommand('apple', 'in')?.args[1]).toContain('+ 1');
    expect(zoomCommand('apple', 'reset')?.args[1]).toContain('to 12');
    expect(zoomCommand('iterm', 'out')?.args[1]).toContain('"Make Text Smaller"');
    expect(zoomCommand('warp', 'reset')?.args[1]).toContain('Reset Font Size');
    expect(zoomCommand('kitty', 'in')).toEqual({ cmd: 'kitty', args: ['@', 'set-font-size', '--', '+1'] });
    expect(zoomCommand('kitty', 'reset')?.args.at(-1)).toBe('0');
    expect(zoomCommand('ghostty', 'in')).toBeUndefined();
  });

  it('explains what to do when it cannot resize', async () => {
    expect(zoomHelp({ id: 'kitty', name: 'kitty' })).toContain('allow_remote_control');
    expect(zoomHelp({ id: 'ghostty', name: 'Ghostty' })).toContain('config');
    expect(zoomHelp({ id: 'unknown', name: 'your terminal' })).toContain('App Shortcuts');
    expect(await zoom('in', { GHOSTTY_RESOURCES_DIR: '/x' })).toMatchObject({ ok: false });
    expect(await zoom('in', { TERM_PROGRAM: 'iTerm.app' }, async () => undefined)).toEqual({ ok: true, message: 'Text bigger' });
    expect(await zoom('reset', { TERM_PROGRAM: 'iTerm.app' }, async () => undefined)).toEqual({ ok: true, message: 'Text back to normal' });
    const denied = await zoom('out', { TERM_PROGRAM: 'iTerm.app' }, async () => {
      throw new Error('osascript is not allowed assistive access (-1719)');
    });
    expect(denied.message).toContain('Accessibility');
    expect((await zoom('out', { TERM_PROGRAM: 'iTerm.app' }, async () => { throw new Error('nope'); })).message).toContain('App Shortcuts');
  });

  it('Option+↑ / Option+↓ (and Ctrl) change text size from anywhere', () => {
    const ctx = { hasApproval: false, hasViewer: false, overlay: false, page: 20, maxChatScroll: 0, suggestions: [], peopleCount: 1, menuSize: 0 };
    expect(handleKey(initialUi, '', { ctrl: true, upArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'in' });
    expect(handleKey(initialUi, '', { ctrl: true, downArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'out' });
    expect(handleKey(initialUi, '', { meta: true, upArrow: true }, ctx).effect).toEqual({ type: 'zoom', dir: 'in' });
  });
});
