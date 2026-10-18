import { useEffect, useRef, useState } from 'react';
import type { ShellLine } from '@klaud/core/collab-store.js';
import { Icon } from '../components/Icon.js';
import { Empty, Working, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/klaud.js';
import f from './files.module.css';
import s from './shared-search.module.css';

/** A search typed for the shell: quoted so spaces stay in it. */
const quoted = (q: string): string => (q.includes('"') ? `'${q.replace(/'/g, '')}'` : `"${q}"`);

/** The search box above the files of a workspace shared with you: Return searches names and contents. */
export function SearchField({ value, onChange, onSearch }: { value: string; onChange: (v: string) => void; onSearch: (q: string | undefined) => void }) {
  return (
    <form
      className={s.field}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(value.trim() || undefined);
      }}
    >
      <Icon name="search" size={12} />
      <input
        className={s.input}
        value={value}
        placeholder="Search names and contents"
        aria-label="Search the files"
        spellCheck={false}
        onChange={(e) => {
          onChange(e.target.value);
          if (!e.target.value) onSearch(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
            onSearch(undefined);
          }
        }}
      />
      {value ? (
        <button type="button" className={s.clear} aria-label="Clear the search" onClick={() => (onChange(''), onSearch(undefined))}>
          <Icon name="x" size={9} />
        </button>
      ) : null}
    </form>
  );
}

/** Highlight what you searched for in a line. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0 || !query) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className={s.mark}>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * What the search found in a shared workspace: files whose name matches, then lines that
 * contain it. It's served by the owner's klaud, read-only (the same search as the terminal UI's
 * `find` and `grep`); a click opens the file beside the list.
 */
export function SearchResults({ id, owner, share, query }: { id: string; owner: string; share: string; query: string }) {
  const api = useApi();
  const shell = useApp((st) => st.shells[id]);
  const [ran, setRan] = useState<{ find: string; grep: string }>();
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    const find = `find ${quoted(query)}`;
    const grep = `grep ${quoted(query)}`;
    setRan(undefined);
    void (async () => {
      // From the top of the workspace, whatever folder the shell was in.
      await api.shell.run(id, 'cd /');
      if (mine !== seq.current) return;
      setRan({ find, grep });
      await api.shell.run(id, find);
      if (mine === seq.current) await api.shell.run(id, grep);
    })();
  }, [id, query]);
  const result = (cmd: string | undefined): readonly ShellLine[] | undefined => (cmd ? [...(shell?.entries ?? [])].reverse().find((e) => e.cmd === cmd)?.out : undefined);
  const names = result(ran?.find);
  const lines = result(ran?.grep);
  const open = (path: string): void => void api.files.open({ owner, share, path });
  const hits = (out: readonly ShellLine[] | undefined) => (out ?? []).filter((o) => o.open);
  const notes = (out: readonly ShellLine[] | undefined) => (out ?? []).filter((o) => !o.open && o.tone !== 'muted');
  const busy = !names || !lines || Boolean(shell?.busy);
  const nothing = !busy && !hits(names).length && !hits(lines).length;
  return (
    <div className={f.list} role="list" aria-label="Search results">
      {nothing ? <Empty icon="search" title={`Nothing matches “${query}”`} detail="Names and file contents were searched. Secrets like .env files are never searched." /> : null}
      {hits(names).length ? <div className={s.group}>Names</div> : null}
      {hits(names).map((o) => (
        <div key={`n:${o.open}`} role="listitem" className={f.row} onClick={() => open(o.open!)} title={o.open}>
          <Icon name="file" size={14} className={f.fileIcon} />
          <span className={f.rowName}>
            <Marked text={o.open!} query={query} />
          </span>
        </div>
      ))}
      {hits(lines).length ? <div className={s.group}>Contents</div> : null}
      {hits(lines).map((o, i) => {
        const m = /^(.*?):(\d+): (.*)$/.exec(o.text);
        return (
          <div key={`g:${i}`} role="listitem" className={cx(f.row, s.hit)} onClick={() => open(o.open!)} title={o.text}>
            <span className={s.where}>
              {m?.[1] ?? o.open}
              <span className={s.line}>:{m?.[2]}</span>
            </span>
            <span className={s.snippet}>
              <Marked text={(m?.[3] ?? o.text).trim()} query={query} />
            </span>
          </div>
        );
      })}
      {[...notes(names), ...notes(lines)].map((o, i) => (
        <div key={`e:${i}`} className={s.note}>
          {o.text}
        </div>
      ))}
      {busy ? (
        <div className={s.busy}>
          <Working /> Searching…
        </div>
      ) : null}
    </div>
  );
}
