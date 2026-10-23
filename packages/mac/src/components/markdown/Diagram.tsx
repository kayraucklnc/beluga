import { useEffect, useState } from 'react';
import { CodeLines } from './CodeLines.js';
import { type DocTheme, useDocTheme } from './use-doc-theme.js';
import m from './markdown.module.css';

/**
 * ```mermaid blocks, drawn. Mermaid loads the first time a document has one (it's big), runs in
 * its strict mode (no scripts, no HTML labels, its output sanitized), and draws again in the
 * window's colors when the look changes.
 */

type MermaidApi = (typeof import('mermaid'))['default'];

let mermaid: Promise<MermaidApi> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let next = 0;

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif';

/** Draw one diagram (one at a time: mermaid's settings are global). */
export function renderDiagram(code: string, theme: DocTheme): Promise<string> {
  mermaid ??= import('mermaid').then((mod) => mod.default);
  const run = queue.then(async () => {
    const api = await mermaid!;
    api.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: theme === 'dark' ? 'dark' : 'neutral',
      fontFamily: FONT,
      themeVariables: { background: 'transparent', fontFamily: FONT, fontSize: '14px' },
    });
    const id = `beluga-mermaid-${++next}`;
    try {
      await api.parse(code);
      const { svg } = await api.render(id, code);
      return svg;
    } finally {
      // A failed render can leave its scratch element behind.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? '';

export function Diagram({ code }: { code: string }) {
  const theme = useDocTheme();
  const [out, setOut] = useState<{ key: string; svg?: string; error?: string }>();
  const key = `${theme}\0${code}`;
  useEffect(() => {
    let alive = true;
    renderDiagram(code, theme).then(
      (svg) => alive && setOut({ key, svg }),
      (err: unknown) => alive && setOut({ key, error: firstLine(err) || 'This diagram has a mistake' }),
    );
    return () => {
      alive = false;
    };
  }, [key]);
  const now = out?.key === key ? out : undefined;
  if (now?.error) {
    return (
      <figure className={m.diagramError}>
        <figcaption>Can’t draw this diagram: {now.error}</figcaption>
        <CodeLines text={code} lang="mermaid" />
      </figure>
    );
  }
  return (
    <figure className={m.diagram} role="img" aria-label="Diagram" data-ready={now?.svg ? 'true' : 'false'}>
      {/* Mermaid's strict mode sanitizes what it draws. */}
      {now?.svg ? <div className={m.diagramSvg} dangerouslySetInnerHTML={{ __html: now.svg }} /> : <div className={m.diagramLoading}>Drawing…</div>}
    </figure>
  );
}
