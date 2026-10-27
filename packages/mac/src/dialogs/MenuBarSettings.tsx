import { useEffect, useRef, useState } from 'react';
import { COUNTS, DEFAULT_MENU_BAR, MENU_BAR_PRESETS, type MenuBarCount, type MenuBarLook, menuBarPresetOf, trayTitle } from '../menubar/menubar-look.js';
import { spoutMs, spoutSvg } from '../menubar/spout.js';
import { Button, Segmented, cx } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { menuBarCounts, playTraySpout } from '../lib/native.js';
import { setPrefs, usePrefs } from '../lib/prefs.js';
import { Dial } from './FireSettings.js';
import { Group, Row, Select } from './settings-controls.js';
import f from './fire-settings.module.css';
import m from './menubar-settings.module.css';

/** The sliders' track: the water's soft blues. */
const WATER = ['#bfdcf7', '#7fb6ea'] as const;

/** The whale as the menu bar shows it, spouting every few seconds (and at once when `kick` changes). */
function Whale({ look, still, kick }: { look: MenuBarLook; still: boolean; kick: number }) {
  const [t, setT] = useState(0);
  const start = useRef<number | undefined>(undefined);
  useEffect(() => {
    start.current = performance.now();
  }, [kick]);
  useEffect(() => {
    if (still) return setT(0);
    const ms = spoutMs(look);
    const gap = look.spout === 'working' ? 900 : 1800;
    let raf = 0;
    const frame = (now: number): void => {
      const at = (now - (start.current ?? now)) % (ms + gap);
      setT(Math.min(1, at / ms));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [look, still]);
  return <span className={m.whale} aria-hidden dangerouslySetInnerHTML={{ __html: spoutSvg(t, look, { w: 45, h: 36 }, 'currentColor') }} />;
}

/** Two menu bars, light and dark, with the whale and its number as they'll look. */
function Preview({ look, title, still, kick }: { look: MenuBarLook; title: string; still: boolean; kick: number }) {
  return (
    <div className={m.stage}>
      {(['light', 'dark'] as const).map((bar) => (
        <div key={bar} className={cx(m.bar, bar === 'dark' && m.dark)}>
          <span className={m.item}>
            <Whale look={look} still={still} kick={kick} />
            {title ? <span className={m.title}>{title}</span> : null}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Settings › Menu Bar (BLG-280): what the number beside the whale up in the menu bar counts, how
 * it reads, and when the whale spouts. A preset sets it all; the rest fine-tunes it, with a live
 * preview at the top.
 */
export function MenuBarSettings() {
  const prefs = usePrefs();
  const look = prefs.menuBar;
  const counts = useApp((st) => menuBarCounts(st), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const [kick, setKick] = useState(0);
  const set = (patch: Partial<MenuBarLook>): void => {
    const next = { ...look, ...patch };
    setPrefs({ menuBar: { ...next, preset: menuBarPresetOf(next) } });
  };
  const still = look.spout === 'off' || prefs.reduceMotion;
  const means = COUNTS.find((c) => c.id === look.count)!;
  // Shown with a sample number when there's nothing to count right now, so you see how it reads.
  const live = trayTitle(look, counts);
  const title = look.count === 'none' ? '' : live || trayTitle(look, { ...counts, [look.count]: 3 });
  return (
    <>
      <Preview look={look} title={title} still={still} kick={kick} />
      <p className={m.means}>
        {look.count === 'none' ? means.means : `The number is ${means.label.toLowerCase()}: ${means.means.charAt(0).toLowerCase()}${means.means.slice(1)}`}
        {look.count !== 'none' && !live ? ' Nothing right now, so it’s hidden; the preview shows 3.' : ''}
      </p>
      <Group title="Start from">
        <div className={f.presets} role="radiogroup" aria-label="Menu bar presets">
          {MENU_BAR_PRESETS.map((p) => (
            <button key={p.id} type="button" role="radio" aria-checked={look.preset === p.id} className={cx(f.preset, look.preset === p.id && f.on)} onClick={() => set(p.look)}>
              <span className={f.presetName}>{p.name}</span>
              <span className={f.presetBlurb}>{p.blurb}</span>
            </button>
          ))}
          {look.preset === 'custom' ? (
            <div className={cx(f.preset, f.on)} role="radio" aria-checked>
              <span className={f.presetName}>Your Own</span>
              <span className={f.presetBlurb}>Tuned by you</span>
            </div>
          ) : null}
        </div>
      </Group>
      <Group title="The number">
        <Row label="Counts">
          <Select label="Counts" value={look.count} onChange={(count: MenuBarCount) => set({ count })} options={COUNTS.map((c) => ({ value: c.id, label: c.label }))} />
        </Row>
        {look.count === 'none' ? null : (
          <Row label="Reads as" detail="It hides at zero.">
            <Segmented
              label="Reads as"
              radio
              value={look.words ? 'words' : 'number'}
              onChange={(v) => set({ words: v === 'words' })}
              options={[
                { value: 'number', label: '3' },
                { value: 'words', label: `3 ${means.word}` },
              ]}
            />
          </Row>
        )}
      </Group>
      <Group title="The spout">
        <Row label="When the whale spouts" detail={prefs.reduceMotion ? 'Reduce Motion is on (Appearance), so the whale keeps still.' : look.spout === 'working' ? 'Every few seconds while a Claude of yours is at work.' : look.spout === 'done' ? 'Once, each time a Claude of yours finishes.' : 'The whale keeps still.'}>
          <Segmented
            label="When the whale spouts"
            radio
            value={look.spout}
            onChange={(spout) => set({ spout })}
            options={[
              { value: 'done', label: 'When Claude Finishes' },
              { value: 'working', label: 'While Claude Works' },
              { value: 'off', label: 'Never' },
            ]}
          />
        </Row>
        {look.spout === 'off' ? null : (
          <>
            <Dial label="Splash" low="A small puff" high="A big splash" value={look.splash} colors={WATER} onChange={(splash) => set({ splash })} />
            <Dial label="Speed" low="Slow" high="Quick" value={look.speed} colors={WATER} onChange={(speed) => set({ speed })} />
            <Row label="Try it" detail="The whale up in your menu bar spouts once.">
              <Button
                size="small"
                disabled={prefs.reduceMotion}
                onClick={() => {
                  setKick((k) => k + 1);
                  playTraySpout();
                }}
              >
                Spout Now
              </Button>
            </Row>
          </>
        )}
      </Group>
      {look.preset !== DEFAULT_MENU_BAR.preset ? (
        <div className={f.reset}>
          <Button size="small" onClick={() => setPrefs({ menuBar: DEFAULT_MENU_BAR })}>
            Back to the Default
          </Button>
        </div>
      ) : null}
    </>
  );
}
