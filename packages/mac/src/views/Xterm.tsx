import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import { useApp, useKlaud } from '../lib/klaud.js';
import { openExternal } from '../lib/system.js';
import s from '../views/terminal.module.css';

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** One terminal program, drawn by xterm.js from its raw bytes (the program runs in klaud). */
export function Xterm({ termKey, start, focus = true }: { termKey: string; start: (size: { cols: number; rows: number }) => void; focus?: boolean }) {
  const { client } = useKlaud();
  const known = useApp((st) => termKey in st.terminals);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.18,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      theme: { background: css('--term-bg') || css('--bg'), foreground: css('--text'), cursor: css('--accent') === 'AccentColor' ? css('--text') : css('--accent'), selectionBackground: 'rgba(120,140,190,0.35)' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.loadAddon(new SearchAddon());
    term.loadAddon(new WebLinksAddon((_e, uri) => void openExternal(uri)));
    term.open(el);
    fit.fit();
    if (!known) start({ cols: term.cols, rows: term.rows });
    const link = client.attachTerminal(termKey);
    const offData = link.onData((d) => term.write(d));
    const offExit = link.onExit((e) => term.write(`\r\n\x1b[2m[exited${e.code !== null ? ` with ${e.code}` : ''}]\x1b[0m\r\n`));
    const input = term.onData((d) => link.write(d));
    link.resize(term.cols, term.rows);
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
        link.resize(term.cols, term.rows);
      } catch {
        // detached
      }
    });
    resize.observe(el);
    if (focus) term.focus();
    return () => {
      resize.disconnect();
      input.dispose();
      offData();
      offExit();
      link.close?.();
      term.dispose();
    };
  }, [termKey, known]);
  return <div ref={box} className={s.xterm} />;
}

