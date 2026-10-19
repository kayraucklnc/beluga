import { describe, expect, it } from 'vitest';
import { brandNotice, brandText } from '../packages/mac/src/lib/brand.js';

/** Core messages in the Mac app's words: "Klaud" in prose, names and commands untouched (packages/mac/src/lib/brand.ts). */
describe('brandText', () => {
  it('capitalises the product name in prose', () => {
    expect(brandText('Stripe asked klaud to slow down. It tries again later.')).toBe('Stripe asked Klaud to slow down. It tries again later.');
    expect(brandText('klaud tells you when something needs you')).toBe('Klaud tells you when something needs you');
    expect(brandText('3 updates in klaud')).toBe('3 updates in Klaud');
    expect(brandText('Another klaud (process 12) is already on the network')).toBe('Another Klaud (process 12) is already on the network');
    expect(brandText("klaud's network, until klaud quits.")).toBe("Klaud's network, until Klaud quits.");
  });

  it('leaves commands, links, paths, files, branches and identifiers alone', () => {
    expect(brandText('The host has a newer klaud. Run klaud update, then join again')).toBe('The host has a newer Klaud. Run klaud update, then join again');
    expect(brandText('They run klaud join <link>.')).toBe('They run klaud join <link>.');
    expect(brandText('Try klaud --help')).toBe('Try klaud --help');
    expect(brandText('Open klaud://join/abc to join')).toBe('Open klaud://join/abc to join');
    expect(brandText('Logs are in ~/.klaud/logs and ~/Downloads/klaud')).toBe('Logs are in ~/.klaud/logs and ~/Downloads/klaud');
    expect(brandText('Saved to app/klaud.json. Commit it to share it')).toBe('Saved to app/klaud.json. Commit it to share it');
    expect(brandText('On branch klaud/add-auth')).toBe('On branch klaud/add-auth');
    expect(brandText('Shared as klaud-attachments')).toBe('Shared as klaud-attachments');
  });

  it('never touches code', () => {
    expect(brandText('Paste `klaud join` into klaud')).toBe('Paste `klaud join` into Klaud');
    expect(brandText('klaud says:\n```\nklaud is great\n```')).toBe('Klaud says:\n```\nklaud is great\n```');
  });

  it('returns other text as it is', () => {
    expect(brandText('Claude finished in add-auth')).toBe('Claude finished in add-auth');
    expect(brandText('Klaud is already right')).toBe('Klaud is already right');
    expect(brandText('klaudia and myklaud')).toBe('klaudia and myklaud');
  });
});

describe('brandNotice', () => {
  it('brands the title, and the body only for the test notification', () => {
    expect(brandNotice({ title: '3 updates in klaud', body: 'fix the klaud docs' })).toEqual({ title: '3 updates in Klaud', body: 'fix the klaud docs' });
    expect(brandNotice({ title: 'Notifications work', body: 'This is how klaud tells you Claude finished or needs you', tag: 'test' }).body).toBe('This is how Klaud tells you Claude finished or needs you');
    expect(brandNotice({ title: 'Notifications work', body: 'This is how klaud tells you' }).body).toBe('This is how Klaud tells you');
  });
});
