import { useEffect, useRef, useState } from 'react';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';
import type { VoiceChoice, VoiceModelId, VoiceWhere } from '../../../src/shared/voice-models';
import { joinPhrases, PhraseCutter, PHRASE_RATE, promptFrom } from '../../../src/shared/voice-phrases';
import { cleanTranscript, MAX_SECONDS, pcm16 } from './dictate';

/**
 * One time speaking into the phone (BLG-160, BLG-161), the same on the phone and in the web build:
 * the recording is cut at your pauses (src/shared/voice-phrases.ts) and each phrase is written down
 * at once, in order, while you keep talking (on your Mac, or on the phone: the platform's `write`),
 * with the words before as Whisper's prompt. When you stop, the last phrase is written and the
 * words go into the box to edit (■), or are sent as you said them (↑).
 *
 * The platforms (lib/voice.ts, lib/voice.web.ts) give the microphone and the writing down; this
 * keeps the phrases, the queue and what the screen shows. Your voice's level is a shared value, so
 * the animation follows it on the UI thread without re-rendering.
 */

export interface Phrase {
  readonly id: number;
  readonly status: 'writing' | 'done' | 'failed';
  readonly text?: string;
}

export type VoiceView =
  | { readonly phase: 'off'; readonly error?: string; readonly note?: string }
  | { readonly phase: 'getting'; readonly model: VoiceModelId; readonly progress: number }
  | { readonly phase: 'listening'; readonly since: number; readonly phrases: readonly Phrase[]; readonly where: VoiceWhere; readonly note?: string }
  /** Stopped: the last phrases are being written down; then they go in (`send`: or are sent). */
  | { readonly phase: 'writing'; readonly phrases: readonly Phrase[]; readonly where: VoiceWhere; readonly send: boolean; readonly note?: string };

/** The microphone: 16 kHz floats as they come. */
export interface AudioSource {
  start(push: (samples: Float32Array) => void): Promise<void>;
  stop(): void;
}

export interface VoicePlatform {
  /** What the setting means now (where, which model, which language). */
  choice(): VoiceChoice;
  /** Before listening: the phone's model here (it may come now, `onProgress`) → false: don't listen. */
  prepare(choice: VoiceChoice, onProgress: (model: VoiceModelId, progress: number) => void): Promise<boolean>;
  /** The microphone may be used (asks the first time). */
  allowed(): Promise<boolean>;
  source(): AudioSource;
  /** One phrase (16-bit PCM) → its words, and a note when it was written somewhere else than chosen (the Mac away). */
  write(pcm: Uint8Array, choice: VoiceChoice, prompt: string | undefined): Promise<{ text: string; note?: string }>;
  /** A new time speaking: forget the last one's trouble (the Mac being away is asked again). */
  begin(): void;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface VoiceSession {
  readonly view: VoiceView;
  /** Your voice now, 0–1, and 1 while it's speech (for the animation, on the UI thread). */
  readonly level: SharedValue<number>;
  readonly speaking: SharedValue<number>;
  start(): Promise<void>;
  /** Stop: the words go into the box ('edit'), or are sent once written down ('send'). */
  finish(how: 'edit' | 'send'): void;
  cancel(): void;
}

export function useVoiceSession(platform: VoicePlatform, on: { readonly text: (words: string) => void; readonly send: (words: string) => void }): VoiceSession {
  const [view, setView] = useState<VoiceView>({ phase: 'off' });
  const level = useSharedValue(0);
  const speaking = useSharedValue(0);
  const handlers = useRef(on);
  handlers.current = on;
  const s = useRef({
    run: 0,
    source: undefined as AudioSource | undefined,
    cutter: undefined as PhraseCutter | undefined,
    samples: new Float32Array(0),
    heard: 0,
    phrases: [] as Phrase[],
    queue: Promise.resolve() as Promise<void>,
    choice: undefined as VoiceChoice | undefined,
    note: undefined as string | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
    view: { phase: 'off' } as VoiceView,
  }).current;
  const show = (v: VoiceView): void => {
    s.view = v;
    setView(v);
  };
  const refresh = (): void => {
    const v = s.view;
    if (v.phase === 'listening' || v.phase === 'writing') show({ ...v, phrases: s.phrases, ...(s.note ? { note: s.note } : {}) });
  };

  const stopSource = (): void => {
    if (s.timer) clearTimeout(s.timer);
    s.timer = undefined;
    s.source?.stop();
    s.source = undefined;
    level.value = 0;
    speaking.value = 0;
  };

  /** A phrase cut out: written down after the ones before it. */
  const writeDown = (from: number, to: number): void => {
    const mine = s.run;
    const id = s.phrases.length;
    const pcm = pcm16(s.samples.subarray(from, to));
    s.phrases = [...s.phrases, { id, status: 'writing' }];
    refresh();
    const choice = s.choice!;
    s.queue = s.queue.then(async () => {
      if (mine !== s.run) return;
      let text: string | undefined;
      try {
        const r = await platform.write(pcm, choice, promptFrom(joinPhrases(s.phrases.map((p) => p.text))));
        text = cleanTranscript(r.text);
        if (r.note) s.note = r.note;
      } catch (e) {
        text = undefined;
        s.note = errorText(e);
      }
      if (mine !== s.run) return;
      s.phrases = s.phrases.map((p) => (p.id === id ? { id, status: text === undefined ? 'failed' : 'done', ...(text ? { text } : {}) } : p));
      refresh();
    });
  };

  const start = async (): Promise<void> => {
    if (s.view.phase !== 'off') return;
    const mine = ++s.run;
    platform.begin();
    s.note = undefined;
    const choice = (s.choice = platform.choice());
    try {
      const ready = await platform.prepare(choice, (model, progress) => mine === s.run && show({ phase: 'getting', model, progress }));
      if (!ready || mine !== s.run) return mine === s.run ? show({ phase: 'off' }) : undefined;
      if (!(await platform.allowed())) return show({ phase: 'off', error: 'Beluga needs the microphone to hear you (Settings › Apps › Beluga).' });
      if (mine !== s.run) return;
      s.samples = new Float32Array(PHRASE_RATE * (MAX_SECONDS + 2));
      s.heard = 0;
      s.phrases = [];
      s.queue = Promise.resolve();
      const cutter = (s.cutter = new PhraseCutter());
      cutter.onFrame = (l, sp) => {
        level.value = l;
        speaking.value = sp ? 1 : 0;
      };
      const source = (s.source = platform.source());
      await source.start((chunk) => {
        if (mine !== s.run) return;
        const room = Math.min(chunk.length, s.samples.length - s.heard);
        s.samples.set(chunk.subarray(0, room), s.heard);
        s.heard += room;
        // A phrase of noise (a click, a cough) isn't worth writing down.
        for (const cut of cutter.push(chunk.subarray(0, room))) if (cut.speechMs >= 200) writeDown(cut.start, cut.end);
      });
      s.timer = setTimeout(() => finish('edit'), MAX_SECONDS * 1000);
      show({ phase: 'listening', since: Date.now(), phrases: [], where: choice.where });
    } catch (e) {
      stopSource();
      if (mine === s.run) show({ phase: 'off', error: /^(The voice model|Your Mac)/.test(errorText(e)) ? errorText(e) : 'Couldn’t start listening. Check your connection and try again.' });
    }
  };

  const finish = (how: 'edit' | 'send'): void => {
    const v = s.view;
    if (v.phase === 'getting') return cancel();
    if (v.phase === 'writing') {
      if (how === 'send' && !v.send) show({ ...v, send: true });
      return;
    }
    if (v.phase !== 'listening') return;
    const mine = s.run;
    stopSource();
    const last = s.cutter?.end();
    s.cutter = undefined;
    if (last && last.speechMs >= 200) writeDown(last.start, last.end);
    show({ phase: 'writing', phrases: s.phrases, where: v.where, send: how === 'send', ...(s.note ? { note: s.note } : {}) });
    void s.queue.then(() => {
      const now = s.view;
      if (mine !== s.run || now.phase !== 'writing') return;
      const words = joinPhrases(s.phrases.map((p) => p.text));
      const failed = s.phrases.some((p) => p.status === 'failed');
      const note = s.note;
      if (!words) return show({ phase: 'off', error: failed ? (note ?? 'Couldn’t write that down. Try again.') : 'Didn’t catch that. Try again a little closer.' });
      show({ phase: 'off', ...(failed ? { error: 'A part of it couldn’t be written down: read it over.' } : note ? { note } : {}) });
      // A part missing never goes unread: it waits in the box.
      if (now.send && !failed) handlers.current.send(words);
      else handlers.current.text(words);
    });
  };

  const cancel = (): void => {
    s.run++;
    stopSource();
    s.cutter = undefined;
    s.phrases = [];
    show({ phase: 'off' });
  };

  // Leaving the screen stops the microphone.
  useEffect(
    () => () => {
      s.run++;
      stopSource();
    },
    [],
  );

  return { view, level, speaking, start, finish, cancel };
}

/** The words so far, for the screen. */
export const wordsOf = (phrases: readonly Phrase[]): string => joinPhrases(phrases.map((p) => p.text));
