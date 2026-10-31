import type { TermColors } from '../../../../src/terminal/import/look.js';
import { Icon } from '../components/Icon.js';
import { Button, Segmented, cx } from '../components/ui.js';
import { termKeyRows, termKeysOf } from '../lib/term-keys.js';
import { colorsFor } from '../lib/terminal-import-model.js';
import type { TermThemePref } from '../lib/terminal-import-model.js';
import { fontStack, looksDark } from '../lib/terminal-look.js';
import { PRESET_FROM, TERMINAL_PRESETS } from '../lib/terminal-themes.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Group, Row, Switch } from './settings-controls.js';
import t from './terminal-settings.module.css';

/** A theme's look in a few lines of a terminal, its own colours (Beluga's when it has none). */
function ThemeCard({ name, colors, on, onPick, font }: { readonly name: string; readonly colors: TermColors | undefined; readonly on: boolean; readonly onPick: () => void; readonly font: string }) {
  const a = (i: number): string | undefined => colors?.ansi[i] ?? undefined;
  return (
    <button type="button" role="radio" aria-checked={on} aria-label={name} className={cx(t.themeCard, on && t.themeCardOn)} onClick={onPick}>
      <span className={t.themeLines} style={{ fontFamily: fontStack(font), ...(colors?.background ? { background: colors.background } : {}), ...(colors?.foreground ? { color: colors.foreground } : {}) }}>
        <span>
          <span style={{ color: a(2) ?? 'var(--ok)' }}>⏺</span> Read(auth.ts)
        </span>
        <span style={{ opacity: 0.55 }}>{'  ⎿ 214 lines'}</span>
        <span>
          <span style={{ color: a(4) ?? 'var(--info)' }}>{'>'}</span> fix the <span style={{ color: a(1) ?? 'var(--error)' }}>failing</span> test
        </span>
        <span style={{ color: a(3) ?? 'var(--warn)' }}>✻ Thinking…</span>
      </span>
      <span className={t.themeName}>
        {name}
        {on ? <Icon name="check" size={12} /> : null}
        <span className={t.themeDots} aria-hidden>
          {[1, 2, 3, 4, 5].map((i) => (
            <i key={i} style={{ background: a(i) ?? 'var(--hairline-strong)' }} />
          ))}
        </span>
      </span>
    </button>
  );
}

/**
 * The terminal's colours (BLG-536): Beluga's own, a theme you brought from another terminal, or a
 * well-known one. Each shows as it will look; one with light colours follows Beluga's appearance.
 */
export function ThemeGroup() {
  const prefs = usePrefs();
  const dark = looksDark();
  const current = prefs.termTheme;
  const imported = current && current.from !== PRESET_FROM ? current : undefined;
  const pick = (theme: TermThemePref | null): void => setPrefs({ termTheme: theme });
  return (
    <Group title="Colours">
      <div className={t.themes} role="radiogroup" aria-label="Terminal colours">
        <ThemeCard name="Beluga" colors={undefined} font={prefs.termFont} on={!current} onPick={() => pick(null)} />
        {imported ? <ThemeCard name={imported.name} colors={colorsFor(imported, dark)} font={prefs.termFont} on onPick={() => pick(imported)} /> : null}
        {TERMINAL_PRESETS.map((p) => (
          <ThemeCard key={p.name} name={p.name} colors={colorsFor(p, dark)} font={prefs.termFont} on={current?.from === PRESET_FROM && current.name === p.name} onPick={() => pick(p)} />
        ))}
      </div>
    </Group>
  );
}

/**
 * The terminal view (BLG-534), for people who'd rather talk to Claude in Claude Code's own
 * terminal app: off by default (everyone has the chat); on, each conversation's header can show it
 * as the chat, the terminal, or both, and this picks how ones you haven't switched open.
 */
export function ViewGroup() {
  const prefs = usePrefs();
  return (
    <Group title="Advanced">
      <Row label="Use Claude Code’s own terminal" detail={prefs.termView ? 'A conversation’s header shows Chat · Terminal · Both (⇧⌘T switches). Graphs, tables and tasks open beside the terminal from their links.' : 'Off: conversations are the chat. On, you can talk to Claude in Claude Code’s own terminal app instead, on the same conversation.'}>
        <Switch label="Use Claude Code’s own terminal" on={prefs.termView} onChange={(v) => setPrefs({ termView: v })} />
      </Row>
      {prefs.termView ? <Row label="Open conversations as" detail={prefs.convoDefault === 'chat' ? 'The chat, drawn. The header’s switch shows the terminal for one conversation.' : prefs.convoDefault === 'terminal' ? 'Your agent’s own terminal; graphs and tables open beside it from their links.' : 'Your agent’s terminal with the chat beside it.'}>
        <Segmented
          label="Open conversations as"
          value={prefs.convoDefault}
          onChange={(v) => setPrefs({ convoDefault: v })}
          options={[
            { value: 'chat', label: 'Chat', icon: 'chat' },
            { value: 'terminal', label: 'Terminal', icon: 'terminal' },
            { value: 'both', label: 'Both', icon: 'columns' },
          ]}
        />
      </Row> : null}
    </Group>
  );
}

/**
 * The terminal's keys (BLG-537): what each does, the ones you brought from your terminal marked,
 * and whether they win over Beluga's shortcuts while the keyboard is in the terminal.
 */
export function KeysGroup() {
  const prefs = usePrefs();
  const rows = termKeyRows(termKeysOf(prefs.termKeys?.keys, prefs.termKeys?.from));
  return (
    <Group title="Keys in the terminal view">
      <Row label="The terminal’s keys come first" detail={prefs.termKeysFirst ? 'While you type in the terminal, ⌘T, ⌘W, ⌘1… and the rest are the terminal’s, as in iTerm2 or Ghostty.' : 'Beluga’s shortcuts win; the terminal keeps only keys Beluga doesn’t use.'}>
        <Switch label="The terminal’s keys come first" on={prefs.termKeysFirst} onChange={(v) => setPrefs({ termKeysFirst: v })} />
      </Row>
      <div className={t.keyList} role="list" aria-label="Terminal keys">
        {rows.map((r) => (
          <div key={r.label} className={t.keyRow} role="listitem">
            <span>{r.label}</span>
            {r.from ? <span className={t.keyFrom}>from {r.from}</span> : null}
            <span className={t.keyKeys}>{r.keys}</span>
          </div>
        ))}
      </div>
      {prefs.termKeys?.keys.length ? (
        <Row label={`${prefs.termKeys.keys.length} keys from ${prefs.termKeys.from || 'your terminal'}`} detail="Brought with Import from…, over Beluga’s.">
          <Button size="small" onClick={() => setPrefs({ termKeys: null })}>
            Use Beluga’s Keys
          </Button>
        </Row>
      ) : null}
    </Group>
  );
}
