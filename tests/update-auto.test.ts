import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INITIAL_UPDATE_STATE, modeOf, switchesOf } from '../packages/mac/src/lib/update-model.js';

describe('the Mac app’s two switches', () => {
  it('Update automatically and Check for updates, as the mode the app shell keeps', () => {
    expect(switchesOf('idle')).toEqual({ auto: true, check: true });
    expect(switchesOf('ask')).toEqual({ auto: false, check: true });
    expect(switchesOf('off')).toEqual({ auto: false, check: false });
    expect(modeOf({ auto: true }, 'ask')).toBe('idle');
    expect(modeOf({ auto: false }, 'idle')).toBe('ask');
    // Updating automatically needs looking; not looking turns it off.
    expect(modeOf({ auto: true }, 'off')).toBe('idle');
    expect(modeOf({ check: false }, 'idle')).toBe('off');
    expect(modeOf({ check: true }, 'off')).toBe('ask');
  });
});

describe('a new install updates automatically (BLG-99)', () => {
  const shell = readFileSync(fileURLToPath(new URL('../packages/mac/src-tauri/src/updater.rs', import.meta.url)), 'utf8');

  it('Settings shows Update automatically on for a new user, and it can be turned off', () => {
    expect(INITIAL_UPDATE_STATE.mode).toBe('idle');
    expect(switchesOf(INITIAL_UPDATE_STATE.mode)).toEqual({ auto: true, check: true });
    // Turning it off is "Ask me", the mode the shell then saves and reads back.
    expect(modeOf({ auto: false }, INITIAL_UPDATE_STATE.mode)).toBe('ask');
    expect(modeOf({ check: false }, INITIAL_UPDATE_STATE.mode)).toBe('off');
  });

  it('the shell starts a new install on idle, and keeps an earlier install’s mode', () => {
    // The window's first guess is the shell's new-install mode…
    expect(shell).toMatch(/const NEW_INSTALL_MODE: Mode = Mode::Idle;/);
    // …but a saved file without a mode (an earlier install) still reads as "Ask me".
    expect(shell).toMatch(/#\[default\]\s*Ask,/);
    // Only no updates.json and nothing else left behind counts as new; the Rust tests
    // (cargo test, updater.rs) cover first_saved and ran_before.
    expect(shell).toMatch(/None if ran_before => \(Saved::default\(\), false\)/);
  });
});
