import { useRef, useState } from 'react';
import { fireVars, DEFAULT_FIRE, type FireLook, type FirePalette, PALETTES, PRESETS, paletteOf, presetOf, reachOf } from '../chat/fire-look.js';
import { MaxFire } from '../chat/MaxFire.js';
import { Icon } from '../components/Icon.js';
import { Button, Segmented, cx } from '../components/ui.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Group, Row, Switch } from './settings-controls.js';
import f from './fire-settings.module.css';
import m from '../chat/max.module.css';
import s from './settings.module.css';

/** The dials, in plain words at each end. */
const DIALS = [
  { key: 'fuel', label: 'Fuel', low: 'A few flames', high: 'A wall of fire' },
  { key: 'height', label: 'Height', low: 'Low', high: 'Towering' },
  { key: 'thickness', label: 'Thickness', low: 'Wispy', high: 'Thick' },
  { key: 'wildness', label: 'Wildness', low: 'Calm', high: 'Wild' },
] as const;

/** Three dots in a palette's colours, edge to core. */
function Dots({ colors }: { colors: readonly string[] }) {
  return (
    <span className={f.dots}>
      {colors.map((c, i) => (
        <span key={i} style={{ background: c }} />
      ))}
    </span>
  );
}

/** A little flame in a palette's colours (the presets' and palettes' picture). */
function Swatch({ colors }: { colors: readonly string[] }) {
  return (
    <svg className={f.swatch} viewBox="0 0 24 30" aria-hidden>
      <path d="M12 1C14 8 22 12 22 20a10 10 0 0 1-20 0C2 14 7 11 8 5c2 3 3 5 3 7 2-3 2-7 1-11z" fill={colors[0]} />
      <path d="M12 9c1 4 6 7 6 12a6 6 0 0 1-12 0c0-3 2-5 3-8 1 2 1 3 1 4 2-2 2-5 2-8z" fill={colors[1]} />
      <path d="M12 17c1 2 3 3 3 5a3 3 0 0 1-6 0c0-2 2-3 3-5z" fill={colors[2]} />
    </svg>
  );
}

/**
 * Settings › Max Fire: how the message box burns on Max effort. A preset sets everything; the
 * sliders, colours and switches fine-tune it. The preview at the top burns as you change it: type
 * or delete there to try it.
 */
export function FireSettings() {
  const look = usePrefs().maxFire;
  const set = (patch: Partial<FireLook>): void => {
    const next = { ...look, ...patch };
    setPrefs({ maxFire: { ...next, preset: presetOf(next) } });
  };
  const colors = paletteOf(look).colors;
  return (
    <>
      <Preview look={look} />
      <Group title="Start from">
        <div className={f.presets} role="radiogroup" aria-label="Fire presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={look.preset === p.id} className={cx(f.preset, look.preset === p.id && f.on)} onClick={() => set(p.look)}>
              <Swatch colors={paletteOf({ palette: p.look.palette, palettes: look.palettes }).colors} />
              <span className={f.presetName}>{p.name}</span>
              <span className={f.presetBlurb}>{p.blurb}</span>
            </button>
          ))}
          {look.preset === 'custom' ? (
            <div className={cx(f.preset, f.on)} role="radio" aria-checked>
              <Swatch colors={colors} />
              <span className={f.presetName}>Your Own</span>
              <span className={f.presetBlurb}>Tuned by you</span>
            </div>
          ) : null}
        </div>
      </Group>
      <Group title="When and how">
        <Row label="When it burns" detail="On Max effort.">
          <Segmented
            label="When it burns"
            radio
            value={look.show}
            onChange={(show) => set({ show })}
            options={[
              { value: 'always', label: 'Always' },
              { value: 'typing', label: 'While Typing' },
              { value: 'off', label: 'Never' },
            ]}
          />
        </Row>
        <Row label="Style">
          <Segmented
            label="Style"
            radio
            value={look.style}
            onChange={(style) => set({ style })}
            options={[
              { value: 'toon', label: 'Flame' },
              { value: 'pixel', label: 'Pixel Art' },
            ]}
          />
        </Row>
      </Group>
      <Group title="The flames">
        {DIALS.map((d) => (
          <div key={d.key} className={f.dial}>
            <span className={f.dialLabel}>{d.label}</span>
            <span className={f.end}>{d.low}</span>
            <input
              type="range"
              aria-label={d.label}
              min={0}
              max={1}
              step={0.05}
              value={look[d.key]}
              className={f.range}
              style={{ '--fill': `${look[d.key] * 100}%`, '--c0': colors[0], '--c1': colors[1] } as React.CSSProperties}
              onChange={(e) => set({ [d.key]: Number(e.target.value) })}
            />
            <span className={f.end}>{d.high}</span>
          </div>
        ))}
      </Group>
      <Colors look={look} set={set} />
      <Group title="Extras">
        <Row label="Flare when you type fast" detail="It loses its temper and burns orange for a moment.">
          <Switch label="Flare when you type fast" on={look.temper} onChange={(temper) => set({ temper })} />
        </Row>
        <Row label="Confetti as you type">
          <Switch label="Confetti as you type" on={look.confetti} onChange={(confetti) => set({ confetti })} />
        </Row>
        <Row label="Deleting pops into pixels" detail="What you delete bursts into little pixels that fall away.">
          <Switch label="Deleting pops into pixels" on={look.popDelete} onChange={(popDelete) => set({ popDelete })} />
        </Row>
      </Group>
      {look.preset !== DEFAULT_FIRE.preset || look.show !== DEFAULT_FIRE.show ? (
        <div className={f.reset}>
          <Button size="small" onClick={() => setPrefs({ maxFire: { ...DEFAULT_FIRE, palettes: look.palettes } })}>
            Back to the Default
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** A box like the message box, burning with these settings: type or delete in it to try them. */
function Preview({ look }: { look: FireLook }) {
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  // Never shown as off here: it's what it would look like.
  const shown = look.show === 'off' ? { ...look, show: 'always' as const } : look;
  return (
    <div className={f.stage} style={{ paddingTop: Math.min(reachOf(look), 200) + 8 }}>
      <div ref={box} className={cx(f.fakeBox, m.max)} style={fireVars(look) as React.CSSProperties}>
        <MaxFire box={box} input={input} look={shown} />
        <textarea ref={input} className={f.fakeInput} rows={2} value={text} placeholder="Type or delete here to try it" aria-label="Try the fire" onChange={(e) => setText(e.target.value)} />
      </div>
    </div>
  );
}

/** The palettes: Beluga's and yours (named by you), and a maker for new ones. */
function Colors({ look, set }: { look: FireLook; set: (patch: Partial<FireLook>) => void }) {
  const [making, setMaking] = useState<FirePalette | undefined>();
  const mine = look.palettes;
  const save = (p: FirePalette): void => {
    const name = p.name.trim() || 'My Colors';
    const palettes = mine.some((x) => x.id === p.id) ? mine.map((x) => (x.id === p.id ? { ...p, name } : x)) : [...mine, { ...p, name }];
    set({ palettes, palette: p.id });
    setMaking(undefined);
  };
  const remove = (id: string): void => {
    set({ palettes: mine.filter((x) => x.id !== id), ...(look.palette === id ? { palette: 'blue' } : {}) });
    setMaking(undefined);
  };
  return (
    <Group title="Colors">
      <div className={f.palettes} role="radiogroup" aria-label="Fire colors">
        {[...PALETTES, ...mine].map((p) => {
          const own = mine.includes(p);
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={look.palette === p.id}
              className={cx(f.palette, look.palette === p.id && f.on)}
              onClick={() => set({ palette: p.id })}
              onDoubleClick={() => own && setMaking(p)}
              title={own ? 'Double-click to change or rename' : undefined}
            >
              <Dots colors={p.colors} />
              {p.name}
              {own && look.palette === p.id ? (
                <span
                  className={f.edit}
                  role="button"
                  tabIndex={0}
                  aria-label={`Change ${p.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMaking(p);
                  }}
                >
                  <Icon name="pencil" size={10} />
                </span>
              ) : null}
            </button>
          );
        })}
        <button type="button" className={cx(f.palette, f.add)} onClick={() => setMaking({ id: `own-${Date.now().toString(36)}`, name: '', colors: [...paletteOf(look).colors] as [string, string, string] })}>
          <Icon name="plus" size={11} />
          New Colors
        </button>
      </div>
      {making ? <Maker palette={making} isNew={!mine.some((x) => x.id === making.id)} onSave={save} onCancel={() => setMaking(undefined)} onDelete={() => remove(making.id)} /> : null}
    </Group>
  );
}

/** Three round wells (edge, middle, core) and a name. */
function Maker({ palette, isNew, onSave, onCancel, onDelete }: { palette: FirePalette; isNew: boolean; onSave: (p: FirePalette) => void; onCancel: () => void; onDelete: () => void }) {
  const [draft, setDraft] = useState(palette);
  const well = (i: 0 | 1 | 2, label: string) => (
    <label className={f.well}>
      <span className={f.wellDot} style={{ background: draft.colors[i] }}>
        <input
          type="color"
          aria-label={label}
          value={draft.colors[i]}
          onChange={(e) => {
            const colors = [...draft.colors] as [string, string, string];
            colors[i] = e.target.value;
            setDraft({ ...draft, colors });
          }}
        />
      </span>
      {label}
    </label>
  );
  return (
    <form
      className={f.maker}
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <Swatch colors={draft.colors} />
      {well(0, 'Edge')}
      {well(1, 'Middle')}
      {well(2, 'Core')}
      <input className={cx(s.text, f.name)} placeholder="Name them, like Dragon’s Breath" aria-label="Name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} autoFocus />
      <span className={f.makerButtons}>
        {isNew ? null : (
          <Button size="small" variant="quiet" onClick={onDelete}>
            Delete
          </Button>
        )}
        <Button size="small" variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="small" variant="primary" type="submit">
          {isNew ? 'Add' : 'Save'}
        </Button>
      </span>
    </form>
  );
}
