import { useEffect, useRef, useState } from 'react';
import { Empty, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/klaud.js';
import s from './lists.module.css';

/** A read-only shell over a workspace shared with you: ls, cd, cat, tree, find, grep; names open. */
export function GuestShellView() {
  const api = useApi();
  const view = useApp((st) => st.view);
  const id = view.kind === 'shared' ? view.id : '';
  const shell = useApp((st) => st.shells[id]);
  const [line, setLine] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [shell?.entries.length]);
  // The box is off while a command runs; you keep typing in it after.
  useEffect(() => {
    if (!shell?.busy) input.current?.focus();
  }, [shell?.busy]);
  if (!id) return null;
  return (
    <div className={s.shell}>
      <div className={`${s.shellLog} selectable`}>
        {shell?.entries.length ? null : <Empty icon="terminal" title="Look around their files" detail="Type ls, cd <folder>, cat <file>, tree, find <name> or grep <text>. Click a name to open it." />}
        {shell?.entries.map((e) => (
          <div key={e.id} className={s.entry}>
            <div className={s.cmd}>
              <span className={s.dim}>{e.cwd || '/'} $</span> {e.cmd}
            </div>
            {e.out.map((o, i) => (
              <div key={i} className={cx(s.out, o.tone && s[`out_${o.tone}`], o.open && s.clickable)} onClick={o.open ? () => void api.shell.openEntry(id, o.open!, Boolean(o.dir)) : undefined}>
                {o.text}
              </div>
            ))}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className={s.shellInput}
        onSubmit={(e) => {
          e.preventDefault();
          if (!line.trim()) return;
          void api.shell.run(id, line);
          setLine('');
        }}
      >
        <span className={s.dim}>{shell?.cwd || '/'} $</span>
        <input ref={input} className="selectable" value={line} onChange={(e) => setLine(e.target.value)} placeholder="ls" autoFocus disabled={shell?.busy} />
      </form>
    </div>
  );
}
