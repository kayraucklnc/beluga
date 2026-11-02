import { useEffect, useState } from 'react';
import type { TermColors, TerminalAppId, TerminalFound } from '@beluga/terminal/import/look.js';
import { Button, IconButton, cx } from '../components/ui.js';
import { useApi } from '../lib/beluga.js';
import { type UiPrefs, getPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { colorsFor, foundLabel, hasLook, importPatch, importSummary } from '../lib/terminal-import-model.js';
import { fontStack, hasFont, looksDark } from '../lib/terminal-look.js';
import { Group, Row, Select } from './settings-controls.js';
import t from './terminal-settings.module.css';

/**
 * Bringing another terminal's look into Beluga's (BLG-212): Settings › Terminal › Import from…,
 * and the pieces the welcome's terminal step shares with it (the list of terminals, the preview,
 * applying one).
 */

let asked: Promise<TerminalFound[]> | undefined;

/** The other terminals on this Mac, asked for once a session (Look Again asks afresh). */
export function useTerminals(): { found: TerminalFound[] | undefined; again: () => void } {
  const api = useApi();
  const [found, setFound] = useState<TerminalFound[]>();
  const load = (fresh: boolean): (() => void) => {
    let live = true;
    if (fresh || !asked) asked = detect(api);
    void asked.then((f) => live && setFound(f));
    return () => void (live = false);
  };
  useEffect(() => load(false), []);
  return {
    found,
    again: () => {
      setFound(undefined);
      load(true);
    },
  };
}

const detect = (api: ReturnType<typeof useApi>): Promise<TerminalFound[]> => api.terminalImport.detect().catch(() => [] as TerminalFound[]);

/** The terminals with something to bring. */
export const importable = (found: readonly TerminalFound[] | undefined): TerminalFound[] => (found ?? []).filter(hasLook);

/** The terminal settings you had before an import (Undo puts them back). */
export type Before = Pick<UiPrefs, 'termTheme' | 'termFont' | 'termFontSize' | 'termLineHeight' | 'termCursor' | 'termCursorBlink' | 'termScrollback' | 'termOptionMeta'>;

export const before = (p: UiPrefs): Before => ({ termTheme: p.termTheme, termFont: p.termFont, termFontSize: p.termFontSize, termLineHeight: p.termLineHeight, termCursor: p.termCursor, termCursorBlink: p.termCursorBlink, termScrollback: p.termScrollback, termOptionMeta: p.termOptionMeta });

/** Apply a terminal's look to Beluga's terminal settings → what they were before. */
export function applyImport(found: TerminalFound): Before {
  const was = before(getPrefs());
  if (found.look) setPrefs(importPatch(found.look, found.name, hasFont).patch);
  return was;
}

/** What your settings would be with `found` applied (for its preview, and the welcome's choice). */
export const withImport = (p: UiPrefs, found: TerminalFound): UiPrefs => (found.look ? { ...p, ...importPatch(found.look, found.name, hasFont).patch } : p);

/** The 16 colours, in two rows of eight. */
export function Swatches({ colors, size = 11 }: { readonly colors: TermColors; readonly size?: number }) {
  return (
    <span className={t.swatches} aria-hidden>
      {colors.ansi.map((c, i) => (
        <i key={i} className={t.sw} style={{ width: size, height: size, ...(c ? { background: c } : { opacity: 0.25 }) }} />
      ))}
    </span>
  );
}

/** A few lines drawn the way your terminal will draw them (its imported colours too). */
export function TermPreview({ prefs, compact = false }: { readonly prefs: UiPrefs; readonly compact?: boolean }) {
  const c = colorsFor(prefs.termTheme, looksDark());
  const a = (i: number): string | undefined => c?.ansi[i] ?? undefined;
  const fg = c?.foreground;
  return (
    <div className={cx(t.preview, compact && t.previewCompact)} aria-hidden style={{ fontFamily: fontStack(prefs.termFont), fontSize: `${compact ? 10.5 : prefs.termFontSize}px`, lineHeight: prefs.termLineHeight, ...(c?.background ? { background: c.background } : {}), ...(fg ? { color: fg } : {}) }}>
      <div>
        <span className={t.dim} style={a(8) ? { color: a(8) } : undefined}>
          ~/Projects/
        </span>
        Beluga{' '}
        <span className={t.branch} style={a(2) ? { color: a(2) } : undefined}>
          main
        </span>
      </div>
      <div>
        <span className={t.prompt} style={a(5) ?? a(4) ? { color: a(5) ?? a(4) } : undefined}>
          ❯
        </span>{' '}
        npm run dev
      </div>
      <div>
        <span style={a(4) ? { color: a(4) } : undefined}>  ready</span> in 312 ms{compact ? <br /> : ' · '}
        {compact ? '  ' : ''}
        <span style={a(6) ? { color: a(6) } : undefined}>http://localhost:5173</span>
        {compact ? <br /> : ' '}
        {compact ? '  ' : ''}
        <span style={a(3) ? { color: a(3) } : undefined}>1 warning</span> <span style={a(1) ? { color: a(1) } : undefined}>0 errors</span>
      </div>
      <div>
        <span className={t.prompt} style={a(5) ?? a(4) ? { color: a(5) ?? a(4) } : undefined}>
          ❯
        </span>{' '}
        <span className={cx(t.cursor, t[`cursor_${prefs.termCursor}`], prefs.termCursorBlink && t.blink)} style={c?.cursor ? { background: c.cursor } : fg ? { background: fg } : undefined}>
          {prefs.termCursor === 'block' ? ' ' : ''}
        </span>
      </div>
    </div>
  );
}

/** What a terminal brings, before you apply it: its look drawn, and the list in words. */
function Pending({ found, onApply, onCancel }: { readonly found: TerminalFound; readonly onApply: () => void; readonly onCancel: () => void }) {
  const prefs = usePrefs();
  const look = found.look!;
  const words = importSummary(look, hasFont);
  return (
    <div className={t.pending}>
      <TermPreview prefs={withImport(prefs, found)} />
      <div className={t.pendingText}>
        <div className={t.brings}>
          {look.theme ? <Swatches colors={colorsFor(look.theme, looksDark())!} size={9} /> : null}
          <span>{words.join(' · ')}</span>
        </div>
        {found.notes.map((n) => (
          <div key={n} className={t.noteLine}>
            {n}
          </div>
        ))}
      </div>
      <div className={t.pendingButtons}>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" icon="download" onClick={onApply}>
          Bring It In
        </Button>
      </div>
    </div>
  );
}

/** Settings › Terminal › Import from…: pick a terminal, see what comes, bring it in (and Undo). */
export function ImportGroup() {
  const prefs = usePrefs();
  const { found, again } = useTerminals();
  const choices = importable(found);
  const [picked, setPicked] = useState<TerminalAppId>();
  const [undo, setUndo] = useState<{ from: string; was: Before }>();
  const pick = choices.find((f) => f.app === picked);
  const others = (found ?? []).filter((f) => !hasLook(f));
  return (
    <Group title="Bring your terminal’s look">
      <Row
        label="Import from"
        detail={
          found === undefined
            ? 'Looking for other terminals on this Mac…'
            : choices.length
              ? 'Colours, font, cursor and the rest, from a terminal you use. You see it before it changes anything.'
              : others.length
                ? `${others.map((f) => f.name).join(', ')}: on their standard settings, nothing to bring.`
                : 'No other terminal’s settings on this Mac (Ghostty, iTerm2, Terminal, Alacritty, kitty, WezTerm, Warp).'
        }
      >
        <Select
          label="Import from"
          value={picked ?? ''}
          placeholder={found === undefined ? 'Looking…' : choices.length ? 'Choose…' : 'None found'}
          disabled={!choices.length}
          onChange={(v) => {
            setPicked(v as TerminalAppId);
            setUndo(undefined);
          }}
          options={[
            ...choices.map((f) => ({ value: f.app, label: foundLabel(f), icon: 'terminal' as const, ...(f.file ? { description: f.file } : {}) })),
          ]}
        />
        <IconButton icon="refresh" label="Look again" onClick={again} />
      </Row>
      {pick ? (
        <Pending
          found={pick}
          onCancel={() => setPicked(undefined)}
          onApply={() => {
            setUndo({ from: foundLabel(pick), was: applyImport(pick) });
            setPicked(undefined);
          }}
        />
      ) : null}
      {undo ? (
        <Row label={`Brought in from ${undo.from}`} detail="Your terminals changed right away. Undo puts back what you had.">
          <Button
            variant="quiet"
            onClick={() => {
              setPrefs(undo.was);
              setUndo(undefined);
            }}
          >
            Undo
          </Button>
        </Row>
      ) : null}
      <Row label="Colours" detail={prefs.termTheme ? `${prefs.termTheme.name}${prefs.termTheme.from ? `, from ${prefs.termTheme.from}` : ''}${prefs.termTheme.light ? ' (light and dark)' : ''}.` : 'Beluga’s own, following light and dark.'}>
        {prefs.termTheme ? (
          <>
            <Swatches colors={colorsFor(prefs.termTheme, looksDark())!} size={10} />
            <Button variant="quiet" onClick={() => setPrefs({ termTheme: null })}>
              Use Beluga’s
            </Button>
          </>
        ) : null}
      </Row>
    </Group>
  );
}
