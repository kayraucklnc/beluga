import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { useBeluga } from '../lib/beluga.js';
import { getPrefs, usePrefs } from '../lib/prefs.js';
import { importedTheme, terminalOptions } from '../lib/terminal-look.js';
import { copyText } from '../lib/copy.js';
import { keyPlatform } from '../lib/shortcuts-model.js';
import { openExternal } from '../lib/system.js';
import s from '../views/terminal.module.css';

/** ⌘← start of line (^A), ⌘→ end of line (^E), ⌘⌫ delete to the start (^U). */
const MAC_LINE_KEYS: Readonly<Record<string, string>> = { ArrowLeft: '\x01', ArrowRight: '\x05', Backspace: '\x15' };

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
/** Beluga's colours for the window's appearance, with the ones you brought from another terminal over them. */
const themeNow = () => ({ background: css('--term-bg') || css('--bg'), foreground: css('--text'), cursor: css('--accent') === 'AccentColor' ? css('--text') : css('--accent'), selectionBackground: 'rgba(120,140,190,0.35)', ...importedTheme(getPrefs()) });

/** One terminal program, drawn by xterm.js from its raw bytes (the program runs in Beluga). */
export function Xterm({ termKey, start, focus = true }: { termKey: string; start: (size: { cols: number; rows: number }) => void; focus?: boolean }) {
  const { client } = useBeluga();
  const box = useRef<HTMLDivElement>(null);
  const live = useRef<{ term: Terminal; refit: () => void } | undefined>(undefined);
  const prefs = usePrefs();
  const look = terminalOptions(prefs);
  // The program is started once per terminal: not again when it shows up in the state, when
  // it's closed (that empties the pane), or when React mounts twice in development.
  const startedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // After the frame that shows the switch, not before it: a click's effects run before its paint, and
    // making a terminal (fonts measured, layout read) would hold up the chat you clicked (KLD-68).
    let stop: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => (timer = setTimeout(() => (stop = mount(el)))));
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      stop?.();
    };
  }, [termKey]);
  /** Make the terminal in `el` and connect it to its program → how to take it down. */
  function mount(el: HTMLDivElement): () => void {
    const term = new Terminal({
      ...terminalOptions(getPrefs()),
      allowProposedApi: true,
      theme: themeNow(),
    });
    // The padding around the text in the terminal's own background (an imported one, too).
    el.style.background = themeNow().background;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new SearchAddon());
    term.loadAddon(new WebLinksAddon((_e, uri) => void openExternal(uri)));
    term.open(el);
    fit.fit();
    if (startedFor.current !== termKey && !(termKey in client.store.getState().terminals)) start({ cols: term.cols, rows: term.rows });
    startedFor.current = termKey;
    const link = client.attachTerminal(termKey);
    const offData = link.onData((d) => term.write(d));
    const offExit = link.onExit((e) => term.write(`\r\n\x1b[2m[exited${e.code !== null ? ` with ${e.code}` : ''}]\x1b[0m\r\n`));
    const input = term.onData((d) => link.write(d));
    // The Mac's line keys, as Terminal and iTerm send them: xterm leaves ⌘ keys to the app.
    term.attachCustomKeyEventHandler((e) => {
      // Linux and Windows terminals copy and paste with Ctrl+Shift+C and V (Ctrl+C is the shell's).
      if (keyPlatform() !== 'mac' && e.ctrlKey && e.shiftKey && !e.altKey && /^[cv]$/i.test(e.key)) {
        if (e.type !== 'keydown') return false;
        e.preventDefault();
        if (e.key.toLowerCase() === 'c') void copyText(term.getSelection());
        else void navigator.clipboard.readText().then((t) => t && term.paste(t), () => undefined);
        return false;
      }
      const line = keyPlatform() === 'mac' && e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey ? MAC_LINE_KEYS[e.key] : undefined;
      if (!line) return true;
      e.preventDefault();
      link.write(line);
      return false;
    });
    // A click in the padding around the text types here too, so Tab completes instead of moving focus away.
    const grab = (e: MouseEvent): void => {
      if (e.button === 0 && !term.element?.contains(e.target as Node)) {
        e.preventDefault();
        term.focus();
      }
    };
    el.addEventListener('mousedown', grab);
    link.resize(term.cols, term.rows);
    const refit = (): void => {
      try {
        fit.fit();
        link.resize(term.cols, term.rows);
      } catch {
        // detached
      }
    };
    live.current = { term, refit };
    const resize = new ResizeObserver(refit);
    resize.observe(el);
    // Follow the appearance (light/dark, accent) as it changes.
    const restyle = new MutationObserver(() => {
      term.options.theme = themeNow();
      el.style.background = themeNow().background;
    });
    restyle.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    if (focus) term.focus();
    return () => {
      live.current = undefined;
      el.removeEventListener('mousedown', grab);
      resize.disconnect();
      restyle.disconnect();
      input.dispose();
      offData();
      offExit();
      link.close?.();
      term.dispose();
    };
  }
  // Your terminal look (Settings › Terminal) applies as you change it; size changes refit.
  useEffect(() => {
    const t = live.current;
    if (!t) return;
    t.term.options = { ...look, theme: themeNow() };
    if (box.current) box.current.style.background = themeNow().background;
    t.refit();
  }, [look.fontFamily, look.fontSize, look.lineHeight, look.cursorStyle, look.cursorBlink, look.scrollback, look.macOptionIsMeta, prefs.termTheme]);
  return <div ref={box} className={s.xterm} />;
}

