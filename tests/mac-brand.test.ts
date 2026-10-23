import { describe, expect, it } from 'vitest';
import { brandNotice, brandText, tildePath } from '../packages/mac/src/lib/brand.js';

/** Core messages in the Mac app's words: "Beluga" in prose, names and commands untouched (packages/mac/src/lib/brand.ts). */
describe('brandText', () => {
  it('capitalises the product name in prose', () => {
    expect(brandText('Stripe asked beluga to slow down. It tries again later.')).toBe('Stripe asked Beluga to slow down. It tries again later.');
    expect(brandText('beluga tells you when something needs you')).toBe('Beluga tells you when something needs you');
    expect(brandText('3 updates in beluga')).toBe('3 updates in Beluga');
    expect(brandText('Another beluga (process 12) is already on the network')).toBe('Another Beluga (process 12) is already on the network');
    expect(brandText("beluga's network, until beluga quits.")).toBe("Beluga's network, until Beluga quits.");
  });

  it('says Beluga for the old name too (a peer on a version from before the rename)', () => {
    expect(brandText('The host has a newer klaud.')).toBe('The host has a newer Beluga.');
    expect(brandText("klaud's network, until klaud quits.")).toBe("Beluga's network, until Beluga quits.");
  });

  it('leaves commands, links, paths, files, branches and identifiers alone', () => {
    expect(brandText('The host has a newer beluga. Run beluga update, then join again')).toBe('The host has a newer Beluga. Run beluga update, then join again');
    expect(brandText('They run beluga join <link>.')).toBe('They run beluga join <link>.');
    expect(brandText('They run klaud join <link>.')).toBe('They run klaud join <link>.');
    expect(brandText('Try beluga --help')).toBe('Try beluga --help');
    expect(brandText('Open beluga://join/abc to join')).toBe('Open beluga://join/abc to join');
    expect(brandText('Open klaud://join/abc to join')).toBe('Open klaud://join/abc to join');
    expect(brandText('Logs are in ~/.beluga/logs and ~/Downloads/beluga')).toBe('Logs are in ~/.beluga/logs and ~/Downloads/beluga');
    expect(brandText('Saved to app/beluga.json. Commit it to share it')).toBe('Saved to app/beluga.json. Commit it to share it');
    expect(brandText('Saved to app/klaud.json. Commit it to share it')).toBe('Saved to app/klaud.json. Commit it to share it');
    expect(brandText('On branch beluga/add-auth')).toBe('On branch beluga/add-auth');
    expect(brandText('Shared as beluga-attachments')).toBe('Shared as beluga-attachments');
  });

  it('never touches code', () => {
    expect(brandText('Paste `beluga join` into beluga')).toBe('Paste `beluga join` into Beluga');
    expect(brandText('beluga says:\n```\nbeluga is great\n```')).toBe('Beluga says:\n```\nbeluga is great\n```');
  });

  it('returns other text as it is', () => {
    expect(brandText('Claude finished in add-auth')).toBe('Claude finished in add-auth');
    expect(brandText('Beluga is already right')).toBe('Beluga is already right');
    expect(brandText('klaudia, belugas and myklaud')).toBe('klaudia, belugas and myklaud');
  });
});

describe('brandNotice', () => {
  it('brands the title, and the body only for the test notification', () => {
    expect(brandNotice({ title: '3 updates in beluga', body: 'fix the beluga docs' })).toEqual({ title: '3 updates in Beluga', body: 'fix the beluga docs' });
    expect(brandNotice({ title: 'Notifications work', body: 'This is how beluga tells you Claude finished or needs you', tag: 'test' }).body).toBe('This is how Beluga tells you Claude finished or needs you');
    expect(brandNotice({ title: 'Notifications work', body: 'This is how beluga tells you' }).body).toBe('This is how Beluga tells you');
  });
});

describe('tildePath', () => {
  it("shows Beluga's folder as ~/.beluga, whatever it was called before", () => {
    const home = '/Users/k';
    expect(tildePath(home, '/Users/k/.beluga/workspaces/api-1/fix')).toBe('~/.beluga/workspaces/api-1/fix');
    expect(tildePath(home, '/Users/k/.klaud/workspaces/api-1/fix')).toBe('~/.beluga/workspaces/api-1/fix');
    expect(tildePath(home, '/Users/k/.klaude/workspaces/api-1/fix')).toBe('~/.beluga/workspaces/api-1/fix');
    expect(tildePath(home, '/Users/k/.klauder/x')).toBe('~/.klauder/x');
  });
});
