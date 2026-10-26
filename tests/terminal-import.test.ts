import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectTerminals } from '../src/terminal/import/detect.js';
import { archivedColor, archivedFont, parseBplist, parsePlist, parseToml, parseXmlPlist, parseYaml } from '../src/terminal/import/formats.js';
import { hexColor } from '../src/terminal/import/look.js';
import { familyFromPostScript, parseAlacritty, parseGhostty, parseIterm, parseKitty, parseTerminalApp, parseWarp, parseWezterm } from '../src/terminal/import/parsers.js';

const b64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'));

// Terminal's own archives (NSKeyedArchiver, binary plists), from its "Clear Dark" profile.
const FONT = b64('YnBsaXN0MDDUAQIDBAUGBwpYJHZlcnNpb25ZJGFyY2hpdmVyVCR0b3BYJG9iamVjdHMSAAGGoF8QD05TS2V5ZWRBcmNoaXZlctEICVRyb290gAGkCwwVFlUkbnVsbNQNDg8QERITFFZOU1NpemVYTlNmRmxhZ3NWTlNOYW1lViRjbGFzcyNAKAAAAAAAABAQgAKAA18QFlNGTW9ub1Rlcm1pbmFsLVJlZ3VsYXLSFxgZGlokY2xhc3NuYW1lWCRjbGFzc2VzVk5TRm9udKIZG1hOU09iamVjdAgRGiQpMjdJTFFTWF5nbnd+hY6QkpStsr3GzdAAAAAAAAABAQAAAAAAAAAcAAAAAAAAAAAAAAAAAAAA2Q==');
const BG = b64('YnBsaXN0MDDUAQIDBAUGBwpYJHZlcnNpb25ZJGFyY2hpdmVyVCR0b3BYJG9iamVjdHMSAAGGoF8QD05TS2V5ZWRBcmNoaXZlctEICVRyb290gAGjCwwTVSRudWxs0w0ODxARElVOU1JHQlxOU0NvbG9yU3BhY2VWJGNsYXNzTxAsMC4wOTgzODc3MTE0NSAwLjExMzg3Nzc0NzYgMC4xNTI2MDI4MzggMC45NQAQAYAC0hQVFhdaJGNsYXNzbmFtZVgkY2xhc3Nlc1dOU0NvbG9yohYYWE5TT2JqZWN0CBEaJCkyN0lMUVNXXWRqd36tr7G2wcrS1QAAAAAAAAEBAAAAAAAAABkAAAAAAAAAAAAAAAAAAADe');
const RED = b64('YnBsaXN0MDDUAQIDBAUGBwpYJHZlcnNpb25ZJGFyY2hpdmVyVCR0b3BYJG9iamVjdHMSAAGGoF8QD05TS2V5ZWRBcmNoaXZlctEICVRyb290gAGjCwwTVSRudWxs0w0ODxARElVOU1JHQlxOU0NvbG9yU3BhY2VWJGNsYXNzTxAnMC43MDUwOTAwODI5IDAuMzM1NzE1NzMwMSAwLjI4MTE0OTA2NDMAEAKAAtIUFRYXWiRjbGFzc25hbWVYJGNsYXNzZXNXTlNDb2xvcqIWGFhOU09iamVjdAgRGiQpMjdJTFFTV11kand+qKqssbzFzdAAAAAAAAABAQAAAAAAAAAZAAAAAAAAAAAAAAAAAAAA2Q==');
const GREY = b64('YnBsaXN0MDDUAQIDBAUGFRhZJGFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb25fEA9OU0tleWVkQXJjaGl2ZXKjBwgPVSRudWxs0wkKCwwNDlYkY2xhc3NcTlNDb2xvclNwYWNlV05TV2hpdGWAAhADRDAuNQDSEBESE1gkY2xhc3Nlc1okY2xhc3NuYW1lohMUV05TQ29sb3JYTlNPYmplY3TRFhdUcm9vdIABEgABhqAIERskKTJESE5VXGlxc3V6f4iTlp6nqq+xAAAAAAAAAQEAAAAAAAAAGQAAAAAAAAAAAAAAAAAAALY=');

const CATPPUCCIN = ['palette = 0=#45475a', 'palette = 1=#f38ba8', 'palette = 15=#a6adc8', 'background = 1e1e2e', 'foreground = cdd6f4', 'cursor-color = f5e0dc', 'selection-background = 585b70', 'selection-foreground = cdd6f4'].join('\n');
const LATTE = ['palette = 0=#5c5f77', 'background = eff1f5', 'foreground = 4c4f69'].join('\n');

describe('colours', () => {
  it('reads every way terminals write a colour', () => {
    expect(hexColor('#1E1E2E')).toBe('#1e1e2e');
    expect(hexColor('0x1e1e2e')).toBe('#1e1e2e');
    expect(hexColor('1e1e2e')).toBe('#1e1e2e');
    expect(hexColor("'#abc'")).toBe('#aabbcc');
    expect(hexColor('#1e1e2eff')).toBe('#1e1e2e');
    expect(hexColor('rgb:ff/80/00')).toBe('#ff8000');
    expect(hexColor('CellForeground')).toBeUndefined();
    expect(hexColor(12)).toBeUndefined();
  });
});

describe('formats', () => {
  it('reads binary plists and keyed archives (Terminal’s colours and font)', () => {
    expect(parseBplist(FONT)).toMatchObject({ $archiver: 'NSKeyedArchiver' });
    expect(archivedFont(FONT)).toEqual({ name: 'SFMonoTerminal-Regular', size: 12 });
    expect(archivedColor(BG)).toBe('#191d27');
    expect(archivedColor(RED)).toBe('#b45648');
    expect(archivedColor(GREY)).toBe('#808080');
    expect(archivedColor(new Uint8Array([1, 2, 3]))).toBeUndefined();
    expect(parseBplist(new TextEncoder().encode('not a plist at all, not even close to one'))).toBeUndefined();
  });

  it('reads XML plists, data and UIDs included', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "x"><plist version="1.0"><dict>
      <key>name</key><string>A &amp; B</string><key>n</key><integer>3</integer><key>r</key><real>0.5</real>
      <key>t</key><true/><key>f</key><false/><key>e</key><string/><key>list</key><array><string>x</string><dict/></array>
      <key>data</key><data>aGk=</data><key>uid</key><dict><key>CF$UID</key><integer>2</integer></dict></dict></plist>`;
    expect(parseXmlPlist(xml)).toEqual({ name: 'A & B', n: 3, r: 0.5, t: true, f: false, e: '', list: ['x', {}], data: new Uint8Array([104, 105]), uid: { UID: 2 } });
    expect(parsePlist(new TextEncoder().encode(xml))).toMatchObject({ n: 3 });
    expect(parseXmlPlist('<plist><dict><key>a</key>')).toBeUndefined();
  });

  it('reads TOML: tables, dotted keys, arrays across lines, inline tables', () => {
    const t = parseToml(`# comment
      title = "x # not a comment"
      [font]
      size = 13.5
      normal = { family = "JetBrains Mono", style = 'Regular' }
      [colors.primary]
      background = '#1e1e2e' # trailing
      [general]
      import = [
        "~/.config/alacritty/themes/a.toml", # one
        'b.toml',
      ]
      [[keyboard.bindings]]
      key = "N"
      broken line here
      ok = true`);
    expect(t).toMatchObject({ title: 'x # not a comment', font: { size: 13.5, normal: { family: 'JetBrains Mono', style: 'Regular' } }, colors: { primary: { background: '#1e1e2e' } }, general: { import: ['~/.config/alacritty/themes/a.toml', 'b.toml'] }, keyboard: { bindings: [{ key: 'N', ok: true }] } });
  });

  it('reads block YAML: nested maps, lists, quoted colours', () => {
    const y = parseYaml(`# theme
name: "My Theme"
background: '#1e1e2e'
terminal_colors:
  normal:
    black: '#000000'   # black
    red: "#ff0000"
  bright:
    white: '#ffffff'
import:
  - one.yml
  - two.yml
size: 12`);
    expect(y).toEqual({ name: 'My Theme', background: '#1e1e2e', terminal_colors: { normal: { black: '#000000', red: '#ff0000' }, bright: { white: '#ffffff' } }, import: ['one.yml', 'two.yml'], size: 12 });
  });
});

describe('fonts by PostScript name', () => {
  it('guesses the family when macOS can’t be asked', () => {
    expect(familyFromPostScript('JetBrainsMono-Regular')).toBe('JetBrains Mono');
    expect(familyFromPostScript('JetBrainsMonoNF-Regular')).toBe('JetBrains Mono Nerd Font');
    expect(familyFromPostScript('FiraCode-Retina')).toBe('Fira Code');
    expect(familyFromPostScript('Menlo-Regular')).toBe('Menlo');
    expect(familyFromPostScript('SFMonoTerminal-Regular')).toBe('');
    expect(familyFromPostScript('SFMono-Regular')).toBe('');
    expect(familyFromPostScript('AndaleMono')).toBe('Andale Mono');
  });
});

describe('Ghostty', () => {
  const read = (name: string): string | undefined => (name === 'theme:Catppuccin Mocha' ? CATPPUCCIN : name === 'theme:Catppuccin Latte' ? LATTE : name === 'extra.conf' ? 'font-size = 15' : undefined);

  it('resolves the theme, and its own colours win over it', () => {
    const p = parseGhostty(['# mine', 'theme = Catppuccin Mocha', 'palette = 1 = #ff0000', 'font-family = ""', 'font-family = "JetBrains Mono"', 'font-family = Symbols Nerd Font', 'font-size = 14', 'cursor-style = bar', 'cursor-style-blink = false', 'macos-option-as-alt = left', 'adjust-cell-height = 10%', 'background-opacity = 0.9'].join('\n'), read);
    expect(p.look?.theme?.name).toBe('Catppuccin Mocha');
    expect(p.look?.theme?.colors).toMatchObject({ background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selection: '#585b70', selectionText: '#cdd6f4' });
    expect(p.look?.theme?.colors.ansi.slice(0, 2)).toEqual(['#45475a', '#ff0000']);
    expect(p.look?.theme?.colors.ansi[15]).toBe('#a6adc8');
    expect(p.look?.theme?.colors.ansi[5]).toBeNull();
    expect(p.look).toMatchObject({ font: 'JetBrains Mono', fontSize: 14, cursor: 'bar', cursorBlink: false, optionMeta: true, lineHeight: 1.3 });
    expect(p.notes).toEqual(['A see-through background stays solid in Beluga.']);
  });

  it('keeps light and dark themes apart, reads included files, and says when a theme is missing', () => {
    const both = parseGhostty('theme = light:Catppuccin Latte,dark:Catppuccin Mocha\nconfig-file = ?extra.conf', read);
    expect(both.look?.theme?.colors.background).toBe('#1e1e2e');
    expect(both.look?.theme?.light?.background).toBe('#eff1f5');
    expect(both.look?.fontSize).toBe(15);
    const missing = parseGhostty('theme = Nope\nfont-size = 12', read);
    expect(missing.look).toEqual({ fontSize: 12 });
    expect(missing.notes[0]).toContain('“Nope”');
    expect(parseGhostty('# nothing\n').look).toBeUndefined();
  });
});

describe('iTerm2', () => {
  const c = (r: number, g: number, b: number) => ({ 'Red Component': r, 'Green Component': g, 'Blue Component': b, 'Color Space': 'sRGB' });
  const profile = (over: Record<string, unknown>) => ({
    Name: 'Work',
    Guid: 'B',
    'Normal Font': 'FiraCode-Retina 13',
    'Background Color': c(0, 0, 0),
    'Foreground Color': c(1, 1, 1),
    'Cursor Color': c(1, 0, 0),
    'Selection Color': c(0.2, 0.2, 0.2),
    ...Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`Ansi ${i} Color`, c(i / 15, 0, 0)])),
    'Cursor Type': 1,
    'Blinking Cursor': true,
    'Vertical Spacing': 1.1,
    'Scrollback Lines': 10000,
    'Option Key Sends': 2,
    ...over,
  });

  it('picks the default profile and reads its colours and font', () => {
    const p = parseIterm({ 'Default Bookmark Guid': 'B', 'New Bookmarks': [profile({ Name: 'Other', Guid: 'A' }), profile({})] } as never);
    expect(p.look?.profile).toBe('Work');
    expect(p.look?.theme?.colors).toMatchObject({ background: '#000000', foreground: '#ffffff', cursor: '#ff0000', selection: '#333333' });
    expect(p.look?.theme?.colors.ansi[15]).toBe('#ff0000');
    expect(p.postscript).toBe('FiraCode-Retina');
    expect(p.look).toMatchObject({ font: 'Fira Code', fontSize: 13, cursor: 'bar', cursorBlink: true, lineHeight: 1.3, scrollback: 10000, optionMeta: true });
  });

  it('keeps separate light and dark colours, and unlimited scrollback', () => {
    const p = parseIterm({ 'New Bookmarks': [profile({ 'Use Separate Colors for Light and Dark Mode': true, 'Background Color (Dark)': c(0.1, 0.1, 0.1), 'Background Color (Light)': c(0.98, 0.98, 0.98), 'Unlimited Scrollback': true, 'Option Key Sends': 0 })] } as never);
    expect(p.look?.theme?.colors.background).toBe('#1a1a1a');
    expect(p.look?.theme?.light?.background).toBe('#fafafa');
    expect(p.look?.theme?.light?.foreground).toBe('#ffffff');
    expect(p.look).toMatchObject({ scrollback: 100_000, optionMeta: false });
    expect(parseIterm({} as never).look).toBeUndefined();
  });
});

describe('Terminal', () => {
  it('reads the default profile’s archived colours and font', () => {
    const p = parseTerminalApp({ 'Default Window Settings': 'Clear Dark', 'Window Settings': { 'Clear Dark': { BackgroundColor: BG, ANSIRedColor: RED, Font: FONT, CursorType: 2, CursorBlink: true, useOptionAsMetaKey: true, FontHeightSpacing: 1 } } } as never);
    expect(p.look?.theme?.colors.background).toBe('#191d27');
    expect(p.look?.theme?.colors.ansi[1]).toBe('#b45648');
    expect(p.look).toMatchObject({ profile: 'Clear Dark', font: '', fontSize: 12, cursor: 'bar', cursorBlink: true, optionMeta: true, lineHeight: 1.18 });
    expect(p.postscript).toBe('SFMonoTerminal-Regular');
  });

  it('a profile on Terminal’s standard colours brings only its font', () => {
    const p = parseTerminalApp({ 'Default Window Settings': 'Basic', 'Window Settings': { Basic: { Font: FONT } } } as never);
    expect(p.look?.theme).toBeUndefined();
    expect(p.look?.fontSize).toBe(12);
    expect(p.notes[0]).toContain('standard colours');
    expect(parseTerminalApp({ 'Default Window Settings': 'Pro' } as never).look).toEqual({ profile: 'Pro' });
  });
});

describe('Alacritty', () => {
  it('reads alacritty.toml with an imported theme under it', () => {
    const theme = '[colors.primary]\nbackground = "#282a36"\nforeground = "#f8f8f2"\n[colors.normal]\nred = "#ff5555"\n[colors.bright]\nwhite = "#ffffff"';
    const p = parseAlacritty(
      ['[general]', 'import = ["~/.config/alacritty/dracula.toml"]', '[font]', 'size = 14', '[font.normal]', 'family = "Hack"', '[font.offset]', 'y = 2', '[colors.primary]', 'foreground = "0xeeeeee"', '[colors.cursor]', 'cursor = "#00ff00"', 'text = "CellBackground"', '[cursor.style]', 'shape = "Beam"', 'blinking = "On"', '[scrolling]', 'history = 20000', '[window]', 'option_as_alt = "Both"', 'opacity = 0.8'].join('\n'),
      (f) => (f.endsWith('dracula.toml') ? theme : undefined),
    );
    expect(p.look?.theme?.colors).toMatchObject({ background: '#282a36', foreground: '#eeeeee', cursor: '#00ff00' });
    expect(p.look?.theme?.colors.cursorText).toBeUndefined();
    expect(p.look?.theme?.colors.ansi[1]).toBe('#ff5555');
    expect(p.look?.theme?.colors.ansi[15]).toBe('#ffffff');
    expect(p.look).toMatchObject({ font: 'Hack', fontSize: 14, cursor: 'bar', cursorBlink: true, scrollback: 20000, optionMeta: true });
    expect(p.look?.lineHeight).toBeGreaterThan(1.18);
    expect(p.notes).toContain('A see-through background stays solid in Beluga.');
  });

  it('reads the older alacritty.yml', () => {
    const p = parseAlacritty(['font:', '  size: 12', '  normal:', '    family: Menlo', 'colors:', '  primary:', "    background: '0x1d1f21'", 'cursor:', '  style: Underline'].join('\n'), undefined, true);
    expect(p.look).toMatchObject({ font: 'Menlo', fontSize: 12, cursor: 'underline', theme: { colors: { background: '#1d1f21' } } });
  });
});

describe('kitty', () => {
  it('reads kitty.conf and the theme it includes', () => {
    const p = parseKitty(['include current-theme.conf', 'font_family      family="JetBrains Mono" style=Regular', 'font_size 13.0', 'cursor_shape beam', 'cursor_blink_interval 0', 'scrollback_lines -1', 'macos_option_as_alt left', 'modify_font cell_height 120%', 'foreground #c0caf5'].join('\n'), (f) =>
      f === 'current-theme.conf' ? 'background #1a1b26\nforeground #a9b1d6\ncolor1 #f7768e\ncursor #c0caf5\nselection_background #33467c' : undefined,
    );
    expect(p.look?.theme?.colors).toMatchObject({ background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selection: '#33467c' });
    expect(p.look?.theme?.colors.ansi[1]).toBe('#f7768e');
    expect(p.look).toMatchObject({ font: 'JetBrains Mono', fontSize: 13, cursor: 'bar', cursorBlink: false, scrollback: 100_000, optionMeta: true, lineHeight: 1.42 });
    expect(parseKitty('font_family Fira Code\nadjust_line_height 110%').look).toMatchObject({ font: 'Fira Code', lineHeight: 1.3 });
  });
});

describe('WezTerm', () => {
  it('reads the usual lines of wezterm.lua, a scheme by name and its own colours over it', () => {
    const lua = `local wezterm = require 'wezterm'
local config = wezterm.config_builder()
-- config.color_scheme = 'Not This'
config.color_scheme = 'Tokyo Night'
config.font = wezterm.font_with_fallback { { family = 'Iosevka Term', weight = 'Medium' }, 'Symbols' }
config.font_size = 15.0
config.line_height = 1.1
config.default_cursor_style = 'BlinkingBar'
config.scrollback_lines = 8000
config.send_composed_key_when_left_alt_is_pressed = false
config.colors = {
  foreground = '#eeeeee',
  ansi = { '#000000', '#ff0000' },
  tab_bar = { background = '#111111' },
}
return config`;
    const p = parseWezterm(lua, (n) => (n === 'scheme:Tokyo Night' ? '[colors]\nbackground = "#1a1b26"\nforeground = "#c0caf5"\nansi = ["#15161e", "#f7768e"]\nbrights = ["#414868"]\n[metadata]\nname = "Tokyo Night"' : undefined));
    expect(p.look?.theme?.name).toBe('Tokyo Night');
    expect(p.look?.theme?.colors).toMatchObject({ foreground: '#eeeeee', background: '#1a1b26' });
    expect(p.look?.theme?.colors.ansi.slice(0, 2)).toEqual(['#000000', '#ff0000']);
    expect(p.look?.theme?.colors.ansi[8]).toBe('#414868');
    expect(p.look).toMatchObject({ font: 'Iosevka Term', fontSize: 15, lineHeight: 1.3, cursor: 'bar', cursorBlink: true, scrollback: 8000, optionMeta: true });
  });

  it('says when a built-in scheme can’t be read', () => {
    const p = parseWezterm("return { color_scheme = 'Builtin Dark', font = wezterm.font('Fira Code') }");
    expect(p.look).toEqual({ font: 'Fira Code' });
    expect(p.notes[0]).toContain('Builtin Dark');
  });
});

describe('Warp', () => {
  it('reads a custom theme and the font from settings.toml', () => {
    const yaml = "name: Night Owl\naccent: '#7fdbca'\nbackground: '#011627'\nforeground: '#d6deeb'\ndetails: darker\nterminal_colors:\n  normal:\n    black: '#011627'\n    red: '#ef5350'\n  bright:\n    white: '#ffffff'\n";
    const p = parseWarp('[appearance]\ntheme = "Night Owl"\n[appearance.text]\nfont_name = "Hack"\nfont_size = 14\nline_height_ratio = 1.2', (n) => (n === 'theme:Night Owl' ? yaml : undefined));
    expect(p.look?.theme?.colors).toMatchObject({ background: '#011627', foreground: '#d6deeb', cursor: '#7fdbca' });
    expect(p.look?.theme?.colors.ansi[1]).toBe('#ef5350');
    expect(p.look?.theme?.colors.ansi[15]).toBe('#ffffff');
    expect(p.look).toMatchObject({ font: 'Hack', fontSize: 14, lineHeight: 1.42 });
  });

  it('reads older Warp’s defaults, and says when the theme is built in', () => {
    const p = parseWarp(undefined, undefined, { Theme: '"Dracula"', FontName: 'Menlo', FontSize: '13' });
    expect(p.look).toEqual({ font: 'Menlo', fontSize: 13 });
    expect(p.notes[0]).toContain('Dracula');
    expect(parseWarp('[privacy]\ntelemetry_enabled = false').notes[0]).toContain('standard look');
  });
});

describe('detecting the terminals on a Mac', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beluga-term-import-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const put = (rel: string, body: string | Uint8Array): void => {
    const file = path.join(home, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  };

  it('finds each one by its app or its settings, and reads them', async () => {
    put('Apps/Ghostty.app/Contents/Resources/ghostty/themes/Catppuccin Mocha', CATPPUCCIN);
    put('Apps/Warp.app/Contents/Info.plist', '');
    put('.config/ghostty/config', 'theme = Catppuccin Mocha\nfont-size = 14\nconfig-file = more\n');
    put('.config/ghostty/more', 'font-family = Monaspace Neon\n');
    put('.config/kitty/kitty.conf', 'include theme.conf\nfont_size 12\n');
    put('.config/kitty/theme.conf', 'background #000000\n');
    put('.config/alacritty/alacritty.toml', '[font]\nsize = 11\n');
    put('.wezterm.lua', "return { color_scheme = 'Catppuccin Mocha' }");
    put('.warp/settings.toml', '[appearance]\ntheme = "Mine"\n');
    put('.warp/themes/mine.yaml', "name: Mine\nbackground: '#123456'\n");
    put('Library/Preferences/com.googlecode.iterm2.plist', `<?xml version="1.0"?><plist version="1.0"><dict><key>New Bookmarks</key><array><dict><key>Name</key><string>Default</string><key>Normal Font</key><string>Monaco 12</string></dict></array></dict></plist>`);
    const found = await detectTerminals({ home, appDirs: [path.join(home, 'Apps')], defaults: false, fonts: false, env: {} });
    const by = Object.fromEntries(found.map((f) => [f.app, f]));
    expect(Object.keys(by).sort()).toEqual(['alacritty', 'ghostty', 'iterm2', 'kitty', 'warp', 'wezterm']);
    expect(by['ghostty']).toMatchObject({ installed: true, file: '~/.config/ghostty/config', look: { font: 'Monaspace Neon', fontSize: 14, theme: { name: 'Catppuccin Mocha', colors: { background: '#1e1e2e' } } } });
    expect(by['kitty']).toMatchObject({ installed: false, look: { fontSize: 12, theme: { colors: { background: '#000000' } } } });
    expect(by['alacritty']?.look).toEqual({ fontSize: 11 });
    // WezTerm's built-in schemes come from Ghostty's copy of the same one.
    expect(by['wezterm']?.look?.theme?.colors.background).toBe('#1e1e2e');
    expect(by['warp']).toMatchObject({ installed: true, look: { theme: { name: 'Mine', colors: { background: '#123456' } } } });
    expect(by['iterm2']).toMatchObject({ installed: false, look: { profile: 'Default', font: 'Monaco', fontSize: 12 } });
  });

  it('finds nothing in an empty home', async () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), 'beluga-term-empty-'));
    try {
      expect(await detectTerminals({ home: empty, appDirs: [], defaults: false, fonts: false, env: {} })).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
