import { memo, useMemo } from 'react';
import { type AnsiStyle, parseAnsi } from '@klaud/shared/ansi.js';
import s from './steps.module.css';

/** The terminal's 16 colours, as theme variables (steps.module.css sets them for light and dark). */
const colorOf = (c: number | string | undefined): string | undefined => (c === undefined ? undefined : typeof c === 'string' ? c : `var(--ansi-${c})`);

function styleOf(st: AnsiStyle): React.CSSProperties | undefined {
  const css: React.CSSProperties = {};
  const fg = colorOf(st.fg);
  const bg = colorOf(st.bg);
  if (fg) css.color = fg;
  if (bg) css.background = bg;
  if (st.bold) css.fontWeight = 600;
  if (st.dim) css.opacity = 0.65;
  if (st.italic) css.fontStyle = 'italic';
  if (st.underline) css.textDecoration = 'underline';
  return Object.keys(css).length ? css : undefined;
}

/** Command output drawn the way the terminal coloured it. */
export const AnsiText = memo(function AnsiText({ text }: { text: string }) {
  const pieces = useMemo(() => parseAnsi(text), [text]);
  return (
    <code className={s.ansi}>
      {pieces.map((p, i) => {
        const style = styleOf(p.style);
        return style ? (
          <span key={i} style={style}>
            {p.text}
          </span>
        ) : (
          p.text
        );
      })}
    </code>
  );
});
