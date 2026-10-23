import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEARCH_THRESHOLD, filterEntries, firstEnabled, flatOptions, matches, menuRows, moveActive, placeMenu, typeahead, wantsSearch } from '../packages/mac/src/components/select-model.js';

type O = { value: string; label: string; description?: string; keywords?: string[]; disabled?: boolean };
const opt = (label: string, extra: Partial<O> = {}): O => ({ value: label.toLowerCase(), label, ...extra });
const trust = [opt('Can’t use my Claude'), opt('Ask me each time', { description: 'You approve each request.' }), opt('Trusted'), opt('Full trust', { disabled: true })];

describe('Beluga’s pop-up button: the menu’s rows', () => {
  it('flattens sections, with a header for each and a line between blocks', () => {
    const entries = [opt('Main'), { section: 'Local', options: [opt('add-auth'), opt('fix')] }, { section: 'Remote', options: [opt('origin/main')] }, opt('Other…')];
    expect(flatOptions(entries).map((o) => o.label)).toEqual(['Main', 'add-auth', 'fix', 'origin/main', 'Other…']);
    expect(menuRows(entries).map((r) => (r.kind === 'option' ? `${r.index}:${r.option.label}` : r.kind === 'header' ? `# ${r.label}` : '—'))).toEqual(['0:Main', '—', '# Local', '1:add-auth', '2:fix', '—', '# Remote', '3:origin/main', '—', '4:Other…']);
  });

  it('skips empty sections and starts without a line', () => {
    expect(menuRows([{ section: 'Empty', options: [] }, { section: '', options: [opt('a')] }]).map((r) => r.kind)).toEqual(['option']);
  });
});

describe('searching a long list', () => {
  it('gets a search field past the threshold, unless told otherwise', () => {
    expect(wantsSearch(SEARCH_THRESHOLD)).toBe(false);
    expect(wantsSearch(SEARCH_THRESHOLD + 1)).toBe(true);
    expect(wantsSearch(3, true)).toBe(true);
    expect(wantsSearch(40, false)).toBe(false);
  });

  it('matches every word anywhere in the label, value, description or keywords, ignoring case and accents', () => {
    expect(matches(opt('feature/Payments-retry'), 'pay retry')).toBe(true);
    expect(matches(opt('feature/payments'), 'pay retry')).toBe(false);
    expect(matches(opt('Ask me each time', { description: 'You approve each request.' }), 'APPROVE')).toBe(true);
    expect(matches(opt('main', { keywords: ['default'] }), 'default')).toBe(true);
    expect(matches(opt('Café'), 'cafe')).toBe(true);
    expect(matches(opt('anything'), '   ')).toBe(true);
  });

  it('keeps a section’s title when anything in it matches, and drops the rest', () => {
    const entries = [opt('main'), { section: 'Remote', options: [opt('origin/main'), opt('origin/fix')] }, { section: 'Tags', options: [opt('v1')] }];
    expect(filterEntries(entries, 'fix')).toEqual([{ section: 'Remote', options: [opt('origin/fix')] }]);
    expect(filterEntries(entries, '')).toEqual(entries);
    expect(filterEntries(entries, 'zzz')).toEqual([]);
  });
});

describe('the keyboard in the menu', () => {
  it('↑↓ move and stop at the ends, skipping what you can’t pick', () => {
    expect(moveActive(trust, 0, 'ArrowDown')).toBe(1);
    expect(moveActive(trust, 2, 'ArrowDown')).toBe(2); // Full trust is off: stays on Trusted
    expect(moveActive(trust, 0, 'ArrowUp')).toBe(0);
    expect(moveActive(trust, -1, 'ArrowDown')).toBe(0);
    expect(moveActive(trust, -1, 'ArrowUp')).toBe(2);
    expect(moveActive(trust, 1, 'Home')).toBe(0);
    expect(moveActive(trust, 0, 'End')).toBe(2);
    expect(moveActive([], 0, 'ArrowDown')).toBe(-1);
  });

  it('PageUp / PageDown jump ten', () => {
    const many = Array.from({ length: 30 }, (_, i) => opt(`b${i}`, { disabled: i === 10 }));
    expect(moveActive(many, 0, 'PageDown')).toBe(9);
    expect(moveActive(many, 25, 'PageDown')).toBe(29);
    expect(moveActive(many, 25, 'PageUp')).toBe(15);
    expect(moveActive(many, 5, 'PageUp')).toBe(0);
  });

  it('finds the first option you can pick in either direction', () => {
    expect(firstEnabled(trust, 3, -1)).toBe(2);
    expect(firstEnabled(trust, 3, 1)).toBe(-1);
  });

  it('type-ahead jumps to a label starting with what’s typed; the same letter again steps on', () => {
    const fonts = [opt('Menlo'), opt('Monaco'), opt('JetBrains Mono'), opt('Fira Code'), opt('Mononoki')];
    expect(typeahead(fonts, 'm', -1)).toBe(0);
    expect(typeahead(fonts, 'm', 0)).toBe(1);
    expect(typeahead(fonts, 'mm', 1)).toBe(4);
    expect(typeahead(fonts, 'mmm', 4)).toBe(0); // wraps around
    expect(typeahead(fonts, 'mon', 0)).toBe(1);
    expect(typeahead(fonts, 'mono', 1)).toBe(4);
    expect(typeahead(fonts, 'JET', 3)).toBe(2);
    expect(typeahead(fonts, 'x', 0)).toBe(-1);
    expect(typeahead(trust, 'f', 0)).toBe(-1); // Full trust can't be picked
  });
});

describe('where the menu opens', () => {
  const base = { triggerTop: 300, triggerHeight: 24, menuHeight: 120, selectedTop: 53, selectedHeight: 22, viewportHeight: 800 };

  it('puts the chosen option right over the button when it fits (a Mac pop-up)', () => {
    const p = placeMenu(base);
    expect(p.mode).toBe('over');
    // The menu's top is the button's middle minus the chosen row's middle.
    expect(300 + 24 + p.sideOffset).toBe(Math.round(312 - (53 + 11)));
  });

  it('drops below when that would go off the top or the bottom, or with a search field', () => {
    expect(placeMenu({ ...base, triggerTop: 20, selectedTop: 90 })).toEqual({ mode: 'below', sideOffset: 4 });
    expect(placeMenu({ ...base, triggerTop: 760 - 24, menuHeight: 200, selectedTop: 5 })).toEqual({ mode: 'below', sideOffset: 4 });
    expect(placeMenu({ ...base, search: true })).toEqual({ mode: 'below', sideOffset: 4 });
    expect(placeMenu({ ...base, selectedTop: undefined })).toEqual({ mode: 'below', sideOffset: 4 });
  });
});

describe('the Mac app has no native pop-ups left', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = path.join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });

  it('every <select> is Beluga’s Select (components/Select.tsx)', () => {
    const native = files('packages/mac/src').filter((f) => /<select[\s>]/.test(readFileSync(f, 'utf8')));
    expect(native).toEqual([]);
  });
});
