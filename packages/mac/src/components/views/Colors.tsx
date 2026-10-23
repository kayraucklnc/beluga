import { useState } from 'react';
import type { Swatch, View } from '@beluga/shared/view-spec.js';
import { Icon } from '../Icon.js';
import { Tip, cx } from '../ui.js';
import { copyText } from '../../lib/copy.js';
import { useActions } from '../../lib/actions.js';
import { contrast, inkOn, parseColor, toHex, toHsl } from './format.js';
import v from './views.module.css';

/**
 * Colors Claude shows: swatches with their names and values (click one to copy it), how each
 * reads with white and black text. With `pick`, each is a picker: change them, add more, then
 * copy them as CSS or JSON, or send them back to Claude in the message box.
 */

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 17, g: 17, b: 17 };

export function ColorsView({ view }: { view: View }) {
  const actions = useActions();
  const [colors, setColors] = useState<Swatch[]>(() => (view.swatches.length ? [...view.swatches] : [{ value: '#3987e5', name: 'Color 1' }]));
  const [copied, setCopied] = useState<number>();
  const pick = view.pick;
  const changed = JSON.stringify(colors) !== JSON.stringify(view.swatches);
  const copyOne = (i: number, text: string): void => {
    void copyText(text).then(() => {
      setCopied(i);
      setTimeout(() => setCopied((n) => (n === i ? undefined : n)), 1200);
    });
  };
  const asCss = (): string => colors.map((c, i) => `--${slug(c.name ?? `color-${i + 1}`)}: ${c.value};`).join('\n');
  const asText = (): string => colors.map((c) => `${c.name ? `${c.name}: ` : ''}${c.value}`).join(', ');
  return (
    <div className={v.colors}>
      <div className={v.swatches} data-pick={pick ? 'true' : undefined}>
        {colors.map((c, i) => {
          const rgb = parseColor(c.value);
          return (
            <div key={i} className={v.swatch}>
              <div className={v.swatchFace} style={{ background: c.value, color: rgb ? inkOn(rgb) : undefined }}>
                {pick && rgb ? (
                  <input type="color" className={v.picker} value={toHex(rgb)} aria-label={`Pick ${c.name ?? `color ${i + 1}`}`} onChange={(e) => setColors((all) => all.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                ) : null}
                {rgb ? (
                  <span className={v.contrast}>
                    <Tip label="Contrast with white text">
                      <span style={{ color: '#fff' }}>Aa {contrast(rgb, WHITE).toFixed(1)}</span>
                    </Tip>
                    <Tip label="Contrast with black text">
                      <span style={{ color: '#111' }}>Aa {contrast(rgb, BLACK).toFixed(1)}</span>
                    </Tip>
                  </span>
                ) : null}
                {pick ? <Icon name="pencil" size={11} className={v.pickMark} /> : null}
              </div>
              <button type="button" className={v.swatchMeta} onClick={() => copyOne(i, c.value)} title="Copy">
                <span className={v.swatchName}>{c.name ?? `Color ${i + 1}`}</span>
                <span className={v.swatchValue}>{copied === i ? 'Copied' : c.value}</span>
                {rgb && !/^hsl/i.test(c.value) ? <span className={v.swatchAlt}>{toHsl(rgb)}</span> : null}
                {c.note ? <span className={v.swatchAlt}>{c.note}</span> : null}
              </button>
              {pick && colors.length > 1 ? (
                <button type="button" className={v.swatchRemove} aria-label={`Remove ${c.name ?? `color ${i + 1}`}`} onClick={() => setColors((all) => all.filter((_, j) => j !== i))}>
                  <Icon name="x" size={9} />
                </button>
              ) : null}
            </div>
          );
        })}
        {pick && colors.length < 64 ? (
          <button type="button" className={v.swatchAdd} onClick={() => setColors((all) => [...all, { value: all.at(-1)?.value ?? '#888888', name: `Color ${all.length + 1}` }])} aria-label="Add a Color">
            <Icon name="plus" size={14} />
          </button>
        ) : null}
      </div>
      <div className={v.colorBar}>
        <button type="button" className={v.action} onClick={() => copyOne(-1, asCss())}>
          <Icon name="copy" size={11} />
          {copied === -1 ? 'Copied' : 'Copy as CSS'}
        </button>
        <button type="button" className={v.action} onClick={() => copyOne(-2, JSON.stringify(colors, null, 2))}>
          <Icon name="copy" size={11} />
          {copied === -2 ? 'Copied' : 'Copy as JSON'}
        </button>
        {pick ? (
          <>
            <span className={v.grow} />
            {changed ? (
              <button type="button" className={v.linkButton} onClick={() => setColors([...view.swatches])}>
                Reset
              </button>
            ) : null}
            <button type="button" className={cx(v.primary)} onClick={() => actions.typeInto(`Use these colors: ${asText()}`)}>
              <Icon name="send" size={11} />
              Use These Colors
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'color';
