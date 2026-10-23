import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { combine, type NoticeEvent } from '../src/core/notify.js';
import { NotifySettings, loadSettings, saveSettings } from '../src/core/settings.js';
import { DEFAULT_SOUND, NO_SOUND, coercePerKind, coerceSound, loudestKind, soundFor, soundGroupOf, soundOn, toggledSound, volumeOf } from '../src/shared/notify-sound.js';

/** Which sound a notification makes (Settings › Notifications), and what became of the old on/off switch. */

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'klaud-sound-')), 'settings.json');
const coin = { kind: 'chip', id: 'coin' } as const;
const purr = { kind: 'mac', id: 'Purr' } as const;

describe('the sound setting', () => {
  it('reads the old on/off switch: on is the default sound, off is none', () => {
    expect(NotifySettings.parse({ sound: true }).sound).toEqual(DEFAULT_SOUND);
    expect(NotifySettings.parse({ sound: false }).sound).toEqual(NO_SOUND);
    expect(NotifySettings.parse({}).sound).toEqual(DEFAULT_SOUND);
    expect(NotifySettings.parse({}).perKind).toBeNull();
    expect(NotifySettings.parse({}).soundVolume).toBe(0.7);
  });

  it('migrates an old settings file without losing anything else', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ name: 'kay', notify: { desktop: true, sound: false, done: false, onlyAway: true } }));
    const s = loadSettings(file);
    expect(s.name).toBe('kay');
    expect(s.notify).toMatchObject({ sound: NO_SOUND, done: false, onlyAway: true, perKind: null, madeSounds: [] });
  });

  it('turns an unreadable sound into the default rather than dropping your notification settings', () => {
    expect(coerceSound({ kind: 'mac', id: 'NotARealSound' })).toEqual(DEFAULT_SOUND);
    expect(coerceSound({ kind: 'gen', seed: -1 })).toEqual(DEFAULT_SOUND);
    expect(coerceSound('loud')).toEqual(DEFAULT_SOUND);
    const parsed = NotifySettings.parse({ sound: { kind: 'chip', id: 'nope' }, done: false, perKind: { done: coin, people: { kind: 'x' }, other: coin } });
    expect(parsed.sound).toEqual(DEFAULT_SOUND);
    expect(parsed.done).toBe(false);
    expect(parsed.perKind).toEqual({ done: coin });
    expect(coercePerKind('x')).toBeNull();
  });

  it('saves and reads back every kind of sound', () => {
    const file = tmpFile();
    const gen = { kind: 'gen', seed: 0xdeadbeef } as const;
    saveSettings({ notify: NotifySettings.parse({ sound: coin, soundVolume: 0.4, perKind: { needsYou: purr, done: gen }, madeSounds: [0xdeadbeef] }) }, file);
    expect(loadSettings(file).notify).toMatchObject({ sound: coin, soundVolume: 0.4, perKind: { needsYou: purr, done: gen }, madeSounds: [0xdeadbeef] });
    expect(() => NotifySettings.parse({ soundVolume: 2 })).toThrow();
  });
});

describe('per-kind sounds', () => {
  const prefs = { sound: coin, perKind: { needsYou: purr, people: NO_SOUND } };

  it('use the same sound for all unless a kind has its own', () => {
    expect(soundFor({ sound: coin, perKind: null }, 'needsYou')).toEqual(coin);
    expect(soundFor(prefs, 'needsYou')).toEqual(purr);
    expect(soundFor(prefs, 'people')).toEqual(NO_SOUND);
    expect(soundFor(prefs, 'mentions')).toEqual(coin);
    // An old boolean still works wherever it turns up.
    expect(soundFor({ sound: false }, 'done')).toEqual(NO_SOUND);
  });

  it('group problems with Claude finishing and pull requests with background work', () => {
    expect(soundGroupOf('problems')).toBe('done');
    expect(soundGroupOf('pr')).toBe('background');
    expect(soundGroupOf('mystery')).toBe('done');
  });

  it('play what needs you first when several kinds arrive at once', () => {
    expect(loudestKind(['background', 'needsYou', 'done'])).toBe('needsYou');
    expect(loudestKind(['people', 'mentions'])).toBe('mentions');
    expect(loudestKind([])).toBe('done');
  });

  it('go with the desktop notification', () => {
    const e = (kind: NoticeEvent['kind']): NoticeEvent => ({ kind, title: kind, body: '' });
    expect(combine([e('needsYou')], { ...prefs, soundVolume: 0.3 })).toEqual({ title: 'needsYou', body: '', sound: true, tone: purr, volume: 0.3 });
    expect(combine([e('people')], prefs)).toMatchObject({ sound: false, tone: NO_SOUND, volume: 0.7 });
    expect(combine([e('people'), e('needsYou')], prefs)).toMatchObject({ sound: true, tone: purr });
    // Callers that only know on/off still get just that.
    expect(combine([e('done')], false)).toEqual({ title: 'done', body: '', sound: false });
  });

  it('are all off only when every kind is silent', () => {
    expect(soundOn({ sound: NO_SOUND })).toBe(false);
    expect(soundOn({ sound: NO_SOUND, perKind: { done: coin } })).toBe(true);
    expect(soundOn({ sound: coin, perKind: Object.fromEntries(['needsYou', 'done', 'mentions', 'people', 'background'].map((g) => [g, NO_SOUND])) })).toBe(false);
  });

  it('the terminal app’s Sound switch turns all of it off, and back on with the default', () => {
    expect(toggledSound(prefs)).toEqual({ sound: NO_SOUND, perKind: null });
    expect(toggledSound({ sound: NO_SOUND })).toEqual({ sound: DEFAULT_SOUND, perKind: null });
  });

  it('keep the volume between 0 and 1', () => {
    expect(volumeOf({ sound: coin, soundVolume: 0.25 })).toBe(0.25);
    expect(volumeOf({ sound: coin, soundVolume: 9 })).toBe(1);
    expect(volumeOf({ sound: coin })).toBe(0.7);
  });
});
