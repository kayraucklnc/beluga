import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Settings, loadSettings, saveSettings, settingsPath } from '../src/core/settings.js';
import { PALETTES, applyTheme, colorFor, theme } from '../src/ui/theme.js';

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-settings-')), 'settings.json');

describe('settings', () => {
  it('defaults when the file is missing or broken', () => {
    const file = tmpFile();
    expect(loadSettings(file)).toMatchObject({ theme: 'calm', mouse: true, tunnel: 'auto', selfApproval: 'never', autoSetup: true, contextMeter: true });
    writeFileSync(file, '{not json');
    expect(loadSettings(file).theme).toBe('calm');
    writeFileSync(file, JSON.stringify({ theme: 'neon' }));
    expect(loadSettings(file).theme).toBe('calm');
  });

  it('merges and persists changes privately', () => {
    const file = tmpFile();
    saveSettings({ name: 'kay' }, file);
    const next = saveSettings({ theme: 'mono', policy: 'auto' }, file);
    expect(next).toMatchObject({ name: 'kay', theme: 'mono', policy: 'auto' });
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toBe('kay');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(() => saveSettings({ name: 'bad name!' }, file)).toThrow();
  });

  it('respects KLAUD_HOME', () => {
    const before = process.env.KLAUD_HOME;
    process.env.KLAUD_HOME = '/tmp/kh';
    expect(settingsPath()).toBe('/tmp/kh/settings.json');
    process.env.KLAUD_HOME = before;
  });
});

describe('plain `klaud` uses saved settings', () => {
  const saved = Settings.parse({ name: 'kay', theme: 'light', policy: 'auto', mouse: false, tunnel: 'none', selfApproval: 'never' });

  it('hosts by default with the saved name and choices', () => {
    const c = parseConfig([], '/tmp/p', '/Users/x', saved);
    expect(c).toMatchObject({ mode: 'host', name: 'kay', policy: 'auto', policyChosen: true, mouse: false, tunnel: 'none', theme: 'light' });
  });

  it('lets flags override saved settings', () => {
    const c = parseConfig(['host', '-n', 'bob', '--policy', 'ask', '--tunnel', 'auto'], '/tmp/p', '/Users/x', saved);
    expect(c).toMatchObject({ name: 'bob', policy: 'ask', tunnel: 'auto' });
    expect(parseConfig(['help'], '/tmp/p', '/Users/x', saved).mode).toBe('help');
    expect(parseConfig(['demo'], '/tmp/p', '/Users/x', saved).mode).toBe('demo');
  });

  it('shows the welcome screen only until a sharing choice is saved', () => {
    expect(parseConfig([], '/tmp/p', '/Users/x', Settings.parse({})).policyChosen).toBe(false);
  });
});

describe('themes', () => {
  it('switches the active palette in place', () => {
    applyTheme('light');
    expect(theme.text).toBe(PALETTES.light.text);
    expect(PALETTES.light.people).toContain(colorFor('bob'));
    applyTheme('calm');
    expect(theme.text).toBe(PALETTES.calm.text);
  });
});
