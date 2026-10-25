import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { TranscriptView, VoiceMacView } from '@beluga/companion/protocol.js';
import { suggestVoice, VOICE_MODELS, type VoiceModelId, voiceKnows, voiceSize } from '@beluga/shared/voice-models.js';
import type { SocketClient } from '@beluga/ipc/socket-client.js';
import { insertText } from '../chat/paste-paths.js';
import { inApp } from './boot.js';
import { getPrefs, usePrefs, type UiPrefs } from './prefs.js';
import { cleanWords, DICTATION_MAX_SECONDS, downsample, HOLD_MS, levelOf, matchesAccel, parseAccel, spoken, wavFromFloats } from './dictation-model.js';

/**
 * Speak instead of typing (BLG-145): the microphone beside Send, and the talk shortcut (Settings ›
 * Voice). The window records (getUserMedia), the daemon writes it down on the Mac's GPU
 * (voice.transcribe: Whisper Turbo or Parakeet, the phone's On your Mac engine), and the words go
 * in at the cursor of the box you were in, to read over; or, with Send right away, they're sent.
 *
 * The shortcut: hold it and talk, let go to write it in; or tap it, talk, then ↩ (or the shortcut
 * again). ⌘↩ writes it in and sends it whatever the setting; esc throws it away. "From any app"
 * registers it with macOS, so it brings Beluga forward and listens from wherever you are.
 */

export type DictationState =
  | { readonly kind: 'off'; readonly error?: string }
  | { readonly kind: 'getting'; readonly model: VoiceModelId; readonly progress: number }
  | { readonly kind: 'listening'; readonly level: number; readonly since: number }
  | { readonly kind: 'writing' };

let state: DictationState = { kind: 'off' };
const subs = new Set<() => void>();
const set = (next: DictationState): void => {
  state = next;
  for (const f of [...subs]) f();
};
export const getDictation = (): DictationState => state;
export function useDictation(): DictationState {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    getDictation,
  );
}

/* ---------- Where the words go: the boxes that take them ---------- */

interface Target {
  readonly el: () => HTMLTextAreaElement | null;
  readonly send: () => void;
}
const targets = new Set<Target>();
let lastTarget: Target | undefined;
/** The box the words go to while one is being written down. */
let into: Target | undefined;
export const dictatingInto = (el: HTMLTextAreaElement | null): boolean => state.kind !== 'off' && Boolean(el) && into?.el() === el;
/** What went wrong shows under the box it was meant for (or the first on screen, when there was none). */
export const errorIn = (el: HTMLTextAreaElement | null): string | undefined =>
  state.kind === 'off' && state.error && el && (into?.el()?.isConnected ? into.el() === el : pickTarget()?.el() === el) ? state.error : undefined;

/** A composer takes dictated words (and Send right away sends them with its own send). */
export function useDictationTarget(ref: React.RefObject<HTMLTextAreaElement | null>, send: () => void): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    const t: Target = { el: () => ref.current, send: () => sendRef.current() };
    targets.add(t);
    const focused = (): void => void (lastTarget = t);
    const el = ref.current;
    el?.addEventListener('focus', focused);
    if (el && document.activeElement === el) lastTarget = t;
    return () => {
      el?.removeEventListener('focus', focused);
      targets.delete(t);
      if (lastTarget === t) lastTarget = undefined;
    };
  }, [ref]);
}

/** The box you're in, else the one you were last in, else the first on screen (the chat's). */
function pickTarget(prefer?: HTMLTextAreaElement | null): Target | undefined {
  const live = [...targets].filter((t) => t.el()?.isConnected && !t.el()?.disabled);
  return live.find((t) => t.el() === prefer) ?? live.find((t) => t.el() === document.activeElement) ?? (lastTarget && live.includes(lastTarget) ? lastTarget : undefined) ?? live[0];
}

/* ---------- The model ---------- */

/** The model the setting means: Parakeet only for a language it knows (never for 'auto', which may be Turkish). */
export function voiceModelOf(p: Pick<UiPrefs, 'voiceModel' | 'voiceLanguage'>): VoiceModelId {
  const m: VoiceModelId = p.voiceModel === 'suggested' ? (suggestVoice({ macVoice: true, language: p.voiceLanguage }) === 'mac-fast' ? 'parakeet' : 'whisper-turbo') : p.voiceModel;
  return voiceKnows(m, p.voiceLanguage) ? m : 'whisper-turbo';
}

let client: SocketClient | undefined;
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The model's here, or comes now (the bar shows how far; esc stops waiting): → it's ready. */
async function modelReady(model: VoiceModelId): Promise<boolean> {
  const api = client!.api;
  let v = (await api.voice.models()) as VoiceMacView;
  const here = (x: VoiceMacView) => x.models.find((m) => m.model === model);
  if (here(v)?.ready) return true;
  v = (await api.voice.prepare(model)) as VoiceMacView;
  for (;;) {
    const m = here(v);
    if (m?.ready) return true;
    if (m?.error && m.progress === undefined) throw new Error(m.error);
    if (state.kind !== 'getting') return false;
    set({ kind: 'getting', model, progress: m?.progress ?? 0 });
    await new Promise((r) => setTimeout(r, 800));
    if (state.kind !== 'getting') return false;
    v = (await api.voice.models()) as VoiceMacView;
  }
}

/* ---------- Recording ---------- */

interface Recording {
  readonly stream: MediaStream;
  readonly ctx: AudioContext;
  readonly node: ScriptProcessorNode;
  readonly chunks: Float32Array[];
  readonly timer: ReturnType<typeof setTimeout>;
}
let rec: Recording | undefined;
/** The shortcut went down at (push-to-talk if it's held past HOLD_MS). */
let keyDownAt: number | undefined;

function stopRecording(): Recording | undefined {
  const r = rec;
  rec = undefined;
  if (!r) return undefined;
  clearTimeout(r.timer);
  r.node.onaudioprocess = null;
  r.node.disconnect();
  for (const t of r.stream.getTracks()) t.stop();
  void r.ctx.close().catch(() => undefined);
  return r;
}

/** Start listening, into the box you're in (or `prefer`). */
export async function startDictation(prefer?: HTMLTextAreaElement | null): Promise<void> {
  if (state.kind !== 'off' || !client) return;
  into = pickTarget(prefer);
  if (!into) return set({ kind: 'off', error: 'Open a chat to speak into' });
  const model = voiceModelOf(getPrefs());
  set({ kind: 'getting', model, progress: 0 });
  try {
    if (!(await modelReady(model))) return;
  } catch (e) {
    return set({ kind: 'off', error: `Couldn’t get ${VOICE_MODELS[model].label}: ${errorText(e)}` });
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    // Esc while macOS asked for the microphone.
    if (getDictation().kind !== 'getting') return void stream.getTracks().forEach((t) => t.stop());
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let shown = 0;
    node.onaudioprocess = (e) => {
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      chunks.push(d);
      // The bar's level about ten times a second, not at every buffer.
      const now = performance.now();
      if (now - shown > 90 && state.kind === 'listening') {
        shown = now;
        set({ ...state, level: levelOf(d) });
      }
    };
    source.connect(node);
    node.connect(ctx.destination);
    rec = { stream, ctx, node, chunks, timer: setTimeout(() => void finishDictation(), DICTATION_MAX_SECONDS * 1000) };
    set({ kind: 'listening', level: 0, since: Date.now() });
  } catch (e) {
    stopRecording();
    const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    set({ kind: 'off', error: denied ? 'Beluga can’t use the microphone: allow it in System Settings › Privacy & Security › Microphone' : `Couldn’t start listening: ${errorText(e)}` });
  }
}

/** Stop listening and write it in (and send it, when asked or set). */
export async function finishDictation(opts: { send?: boolean } = {}): Promise<void> {
  if (state.kind === 'getting') return cancelDictation();
  if (state.kind !== 'listening' || !client) return;
  const r = stopRecording();
  const target = into;
  if (!r || !target) return set({ kind: 'off' });
  const all = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of r.chunks) all.set(c, (at += c.length) - c.length);
  const samples = downsample(all, r.ctx.sampleRate);
  // Less than a third of a second is a tap, not words.
  if (samples.length < 16_000 * 0.3) return set({ kind: 'off' });
  set({ kind: 'writing' });
  const p = getPrefs();
  try {
    const wav = wavFromFloats(samples);
    let bin = '';
    for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
    const r2 = (await client.api.voice.transcribe(btoa(bin), { model: voiceModelOf(p), language: p.voiceLanguage })) as TranscriptView;
    const words = cleanWords(r2.text);
    if (!words) return set({ kind: 'off', error: 'Didn’t catch that. Try again a little closer to the microphone.' });
    const el = target.el();
    if (!el?.isConnected) return set({ kind: 'off', error: 'That chat closed before it was written down' });
    insertText(el, spoken(el.value.slice(0, el.selectionStart ?? el.value.length), words));
    set({ kind: 'off' });
    // After React has the words in its state.
    if (opts.send ?? p.voiceSend) requestAnimationFrame(() => target.send());
  } catch (e) {
    set({ kind: 'off', error: `Couldn’t write that down: ${errorText(e)}` });
  }
}

export function cancelDictation(): void {
  stopRecording();
  keyDownAt = undefined;
  set({ kind: 'off' });
}

/** The mic button: start, or write it in. */
export function toggleDictation(prefer?: HTMLTextAreaElement | null): void {
  if (state.kind === 'off') void startDictation(prefer);
  else if (state.kind === 'listening') void finishDictation();
  else if (state.kind === 'getting') cancelDictation();
}

export const clearDictationError = (): void => {
  if (state.kind === 'off' && state.error) set({ kind: 'off' });
};

/** The bar's words for the model coming. */
export const gettingLine = (s: Extract<DictationState, { kind: 'getting' }>): string =>
  s.progress > 0 ? `Getting ${VOICE_MODELS[s.model].label} on this Mac · ${Math.round(s.progress * 100)}% of ${voiceSize(VOICE_MODELS[s.model].files.mac?.bytes ?? 0)}, once` : 'Getting ready…';

/* ---------- The shortcut ---------- */

/** The shortcut pressed: start (and note when, for push-to-talk), or, listening already, write it in. */
function shortcutDown(): void {
  if (state.kind === 'off') {
    keyDownAt = Date.now();
    void startDictation();
  } else if (state.kind === 'listening') {
    keyDownAt = undefined;
    void finishDictation();
  } else if (state.kind === 'getting') cancelDictation();
}
/** Let go after holding it: push-to-talk, so it's written in now. A tap keeps listening. */
function shortcutUp(): void {
  const held = keyDownAt !== undefined && Date.now() - keyDownAt >= HOLD_MS;
  keyDownAt = undefined;
  if (!held) return;
  if (state.kind === 'listening') void finishDictation();
  // Let go while it was still getting ready: nothing was said yet.
  else if (state.kind === 'getting') cancelDictation();
}

/** Mounted once (App): the API, the in-window shortcut, ↩ and esc while listening, and From any app. */
export function useDictationSetup(c: SocketClient): void {
  client = c;
  const prefs = usePrefs();
  const accel = prefs.voiceShortcut ? parseAccel(prefs.voiceShortcut) : undefined;
  const global = prefs.voiceAnyApp && inApp() && Boolean(accel);
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (state.kind !== 'off') {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          return cancelDictation();
        }
        if (e.key === 'Enter' && state.kind === 'listening' && !e.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          return void finishDictation(e.metaKey || e.ctrlKey ? { send: true } : {});
        }
      }
      if (!accel || global || e.repeat || !matchesAccel(accel, e)) return;
      e.preventDefault();
      e.stopPropagation();
      shortcutDown();
    };
    const up = (e: KeyboardEvent): void => {
      if (accel && !global && e.code === accel.code) shortcutUp();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [accel?.code, accel?.cmd, accel?.ctrl, accel?.alt, accel?.shift, global]);

  // From any app: macOS hands Beluga the shortcut wherever you are; it comes forward and listens.
  useEffect(() => {
    if (!global) return;
    const shortcut = prefs.voiceShortcut;
    let alive = true;
    let registered = false;
    void import('@tauri-apps/plugin-global-shortcut')
      .then(async ({ register, unregister }) => {
        await register(shortcut, (ev) => {
          if (ev.state === 'Pressed') {
            void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
              const w = getCurrentWindow();
              await w.unminimize().catch(() => undefined);
              await w.show().catch(() => undefined);
              await w.setFocus().catch(() => undefined);
            });
            shortcutDown();
          } else shortcutUp();
        });
        registered = true;
        if (!alive) await unregister(shortcut);
      })
      .catch((e: unknown) => client?.store.dispatch({ type: 'toast', text: `The talk shortcut ${shortcut} couldn’t be set for every app (another app may use it): ${errorText(e)}`, level: 'warn' }));
    return () => {
      alive = false;
      if (registered) void import('@tauri-apps/plugin-global-shortcut').then(({ unregister }) => unregister(shortcut)).catch(() => undefined);
    };
  }, [global, prefs.voiceShortcut]);

  // Errors fade after a while.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const f = (): void => {
      if (t) clearTimeout(t);
      if (state.kind === 'off' && state.error) t = setTimeout(clearDictationError, 6000);
    };
    subs.add(f);
    return () => {
      subs.delete(f);
      if (t) clearTimeout(t);
    };
  }, []);
}
