import { useEffect, useRef, useState } from 'react';
import { type EnvVar, envProblems, importEnv, parseEnvText } from '@beluga/shared/env-vars.js';
import { Icon } from '../components/Icon.js';
import { Button, Tip, cx } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Select, Switch } from './settings-controls.js';
import s from './settings.module.css';
import e from './env-settings.module.css';

interface EnvRow extends EnvVar {
  readonly id: number;
}

let nextId = 1;
const withIds = (vars: readonly EnvVar[]): EnvRow[] => vars.map((v) => ({ ...v, id: nextId++ }));
const filled = (rows: readonly EnvVar[]): EnvVar[] => rows.filter((r) => r.key || r.value).map(({ key, value }) => ({ key, value }));
const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Bad arguments for env\.set: /, '') : String(err));

type Status = { kind: 'idle' } | { kind: 'saved' } | { kind: 'error'; text: string };

/** Paste KEY=value lines (a .env, an export block) to add them all at once. */
function ImportBox({ onImport, onClose }: { onImport: (vars: EnvVar[]) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const parsed = parseEnvText(text);
  return (
    <div className={e.importBox}>
      <textarea className={e.importText} aria-label="KEY=value lines" autoFocus spellCheck={false} placeholder={'API_URL=https://api.example.com\nexport TOKEN="…"'} value={text} onChange={(ev) => setText(ev.target.value)} />
      <div className={e.importBar}>
        <span className={e.muted}>{text.trim() ? `${parsed.vars.length} variable${parsed.vars.length === 1 ? '' : 's'}${parsed.skipped.length ? ` · ${parsed.skipped.length} line${parsed.skipped.length === 1 ? '' : 's'} skipped` : ''}` : 'Lines like KEY=value. # comments and export are fine.'}</span>
        <span className={e.flex} />
        <Button size="small" variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button size="small" variant="primary" disabled={!parsed.vars.length} onClick={() => onImport(parsed.vars)}>
          Add {parsed.vars.length || ''}
        </Button>
      </div>
    </div>
  );
}

/** The key/value editor for one place: yours, or a project's. Changes save as you leave a field. */
function Editor({ projectId }: { projectId: string }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const keysHere = useApp((st) => (project ? st.envKeys.projects[project.root] : st.envKeys.global));
  const [rows, setRows] = useState<EnvRow[] | undefined>(undefined);
  const [dotenv, setDotenv] = useState(false);
  const [dotenvKeys, setDotenvKeys] = useState<readonly string[]>([]);
  const [claudeDotenv, setClaudeDotenv] = useState(false);
  const [overridden, setOverridden] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [focusId, setFocusId] = useState<number | undefined>(undefined);
  const saved = useRef('');
  const editing = useRef(false);

  // Load the values (only this screen gets them), and again if another screen changes them.
  useEffect(() => {
    if (editing.current) return;
    let live = true;
    void api.env.get(projectId || undefined).then((scope) => {
      if (!live) return;
      saved.current = JSON.stringify([filled(scope.vars), scope.dotenv]);
      setRows(withIds(scope.vars));
      setDotenv(scope.dotenv);
      setDotenvKeys(scope.dotenvKeys);
      setClaudeDotenv(scope.claudeDotenv);
      setOverridden(scope.overridden ?? {});
    });
    return () => void (live = false);
  }, [projectId, keysHere]);

  const problems = envProblems(rows ?? []);
  const commit = (next: readonly EnvRow[], nextDotenv = dotenv): void => {
    editing.current = false;
    if (envProblems(next).size) return setStatus({ kind: 'error', text: 'Fix the highlighted names to save' });
    const snapshot = JSON.stringify([filled(next), nextDotenv]);
    if (snapshot === saved.current) return;
    api.env.set(projectId || undefined, filled(next), projectId ? nextDotenv : undefined).then(
      () => {
        saved.current = snapshot;
        setStatus({ kind: 'saved' });
      },
      (err: unknown) => setStatus({ kind: 'error', text: errorText(err) }),
    );
  };
  const change = (id: number, patch: Partial<EnvVar>): void => {
    editing.current = true;
    setStatus({ kind: 'idle' });
    setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };
  const add = (): void => {
    const row = withIds([{ key: '', value: '' }])[0]!;
    setRows((rs) => [...(rs ?? []), row]);
    setFocusId(row.id);
  };
  const addAll = (vars: readonly EnvVar[]): void => {
    const next = importEnv(rows ?? [], vars);
    const known = new Map((rows ?? []).map((r) => [r.key, r.id]));
    const merged = next.map((v) => ({ ...v, id: known.get(v.key) ?? nextId++ }));
    setRows(merged);
    setImporting(false);
    commit(merged);
  };
  const remove = (id: number): void => {
    const next = (rows ?? []).filter((r) => r.id !== id);
    setRows(next);
    commit(next);
  };

  // Closing Settings (or switching place) mid-edit saves it too: a field left without a blur isn't lost.
  const saveOnClose = useRef<() => void>(() => undefined);
  saveOnClose.current = () => {
    if (editing.current && rows) commit(rows);
  };
  useEffect(() => () => saveOnClose.current(), []);

  if (!rows) return <div className={s.note}>Loading…</div>;
  const masked = (id: number): boolean => !showAll && !shown.has(id);
  return (
    <>
      <Group>
        <div className={e.head}>
          <span>Name</span>
          <span>Value</span>
          <Tip label={showAll ? 'Hide the values' : 'Show the values'}>
            <button type="button" className={cx(e.eye, showAll && e.eyeOn)} aria-label="Show values" aria-pressed={showAll} onClick={() => setShowAll(!showAll)}>
              <Icon name="eye" size={13} />
            </button>
          </Tip>
          <span />
        </div>
        {rows.length ? null : <div className={e.empty}>No variables yet. Add one, or paste a few KEY=value lines.</div>}
        {rows.map((r, i) => (
          <div key={r.id} className={cx(e.row, problems.has(i) && e.bad)}>
            <input
              className={e.key}
              aria-label="Name"
              aria-invalid={problems.has(i)}
              value={r.key}
              placeholder="NAME"
              spellCheck={false}
              autoComplete="off"
              autoFocus={r.id === focusId}
              onChange={(ev) => change(r.id, { key: ev.target.value.trim() })}
              onBlur={() => commit(rows)}
              onPaste={(ev) => {
                const text = ev.clipboardData.getData('text');
                const pasted = /[=\n]/.test(text) ? parseEnvText(text).vars : [];
                if (!pasted.length) return;
                ev.preventDefault();
                addAll(pasted);
              }}
            />
            <input
              className={cx(e.value, masked(r.id) && r.value && e.masked)}
              aria-label={`Value of ${r.key || 'the new variable'}`}
              value={r.value}
              placeholder="value"
              spellCheck={false}
              autoComplete="off"
              onChange={(ev) => change(r.id, { value: ev.target.value })}
              onBlur={() => commit(rows)}
            />
            <button type="button" className={cx(e.eye, !masked(r.id) && e.eyeOn)} aria-label={masked(r.id) ? `Show ${r.key || 'value'}` : `Hide ${r.key || 'value'}`} aria-pressed={!masked(r.id)} disabled={showAll} onClick={() => setShown((set) => (set.has(r.id) ? new Set([...set].filter((x) => x !== r.id)) : new Set([...set, r.id])))}>
              <Icon name="eye" size={13} />
            </button>
            <button type="button" className={e.remove} aria-label={`Remove ${r.key || 'this row'}`} onClick={() => remove(r.id)}>
              <Icon name="x" size={10} />
            </button>
            {problems.has(i) ? <div className={e.problem}>{problems.get(i)}</div> : null}
            {!problems.has(i) && overridden[r.key]?.length ? (
              <div className={e.override}>
                Not used in {overridden[r.key]!.join(', ')}: {overridden[r.key]!.length > 1 ? 'they set' : 'it sets'} {r.key} too, and that wins. Change it there.
              </div>
            ) : null}
          </div>
        ))}
        {importing ? <ImportBox onImport={addAll} onClose={() => setImporting(false)} /> : null}
        <div className={e.foot}>
          <Button size="small" variant="quiet" icon="plus" onClick={add}>
            Add variable
          </Button>
          {importing ? null : (
            <Button size="small" variant="quiet" icon="clip" onClick={() => setImporting(true)}>
              Paste lines…
            </Button>
          )}
          <span className={e.flex} />
          <span className={cx(e.status, status.kind === 'error' && e.statusError)} role="status">
            {status.kind === 'saved' ? (
              <>
                <Icon name="check" size={11} /> Saved
              </>
            ) : status.kind === 'error' ? (
              status.text
            ) : null}
          </span>
        </div>
      </Group>
      {projectId ? (
        <Group title="From the project folder">
          <Row label="Also load .env" detail={dotenvKeys.length ? `${dotenvKeys.slice(0, 6).join(', ')}${dotenvKeys.length > 6 ? ` and ${dotenvKeys.length - 6} more` : ''}. The variables above win over these.` : 'There’s no .env in the project folder yet.'}>
            <Switch
              label="Also load .env from the project folder"
              on={dotenv}
              onChange={(v) => {
                setDotenv(v);
                commit(rows, v);
              }}
            />
          </Row>
        </Group>
      ) : null}
      <DatabaseTest projectId={projectId} />
      <Group title="Your Claude">
        <Row
          label="Read .env files without asking"
          detail={
            projectId
              ? 'In this project. Off: your Claude asks you each time it wants one. A friend’s request never gets them.'
              : 'In every project. Off: your Claude asks you each time (or as each project says). A friend’s request never gets them.'
          }
        >
          <Switch
            label="Your Claude reads .env files without asking"
            on={claudeDotenv}
            onChange={(v) => {
              setClaudeDotenv(v);
              api.env.claudeDotenv(projectId || undefined, v).then(
                () => setStatus({ kind: 'saved' }),
                (err: unknown) => {
                  setClaudeDotenv(!v);
                  setStatus({ kind: 'error', text: errorText(err) });
                },
              );
            }}
          />
        </Row>
      </Group>
    </>
  );
}

/**
 * Whether the database your Claude's views would use here answers: the same lookup they make
 * (DATABASE_URL and the like, or Supabase's variables), so a pass here works for them too.
 */
function DatabaseTest({ projectId }: { projectId: string }) {
  const api = useApi();
  const [result, setResult] = useState<{ ok: true; from: string } | { ok: false; message: string } | 'testing' | undefined>(undefined);
  const test = (): void => {
    setResult('testing');
    api.env.testDatabase(projectId || undefined).then(setResult, (err: unknown) => setResult({ ok: false, message: errorText(err) }));
  };
  return (
    <Group title="Database">
      <Row
        label="Postgres for your Claude’s views"
        detail={
          result === undefined || result === 'testing'
            ? 'Uses DATABASE_URL (or POSTGRES_URL…), or a Supabase project’s URL and SUPABASE_DB_PASSWORD, from here or the project’s .env.'
            : result.ok
              ? `Connected, using ${result.from}.`
              : result.message
        }
      >
        <Button size="small" icon={result !== undefined && result !== 'testing' && result.ok ? 'check' : undefined} disabled={result === 'testing'} onClick={test}>
          {result === 'testing' ? 'Testing…' : 'Test Connection'}
        </Button>
      </Row>
    </Group>
  );
}

/**
 * Settings › Environment: variables Beluga gives your shells, setup and run commands, and your
 * Claude. Yours apply everywhere; a project's apply in its workspaces, over yours.
 */
export function EnvironmentSettings() {
  const projects = useApp((st) => st.projects).filter((p) => p.root);
  const envKeys = useApp((st) => st.envKeys);
  const [scope, setScope] = useState('');
  const count = (n: number): string => (n ? ` · ${n}` : '');
  return (
    <>
      <p className={e.intro}>
        Given to your shells, setup and run commands, and your Claude, never to a friend’s request. They stay on this Mac. Changes apply right away to your Claude’s next message and to new shells; a shell or dev server already running offers to restart with them.
      </p>
      <Group>
        <Row label="Variables for" detail={scope ? 'This project’s workspaces. They win over yours.' : 'Every shell, script and Claude run.'}>
          <Select
            label="Variables for"
            value={scope}
            onChange={setScope}
            options={[
              { value: '', label: `Everywhere${count(envKeys.global.length)}` },
              ...projects.map((p) => ({ value: p.id, label: `${p.name}${count(envKeys.projects[p.root]?.keys.length ?? 0)}` })),
            ]}
          />
        </Row>
      </Group>
      <Editor key={scope} projectId={scope} />
    </>
  );
}
