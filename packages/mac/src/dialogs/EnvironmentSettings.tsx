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

/**
 * The key/value editor for one place: yours, or a project's. Changes save as you leave a field.
 * A project's main folder .env shows under its own variables (BLG-369): typing over one of its
 * values sets it in Beluga, which wins; Use .env takes that back.
 */
export function EnvEditor({ projectId }: { projectId: string }) {
  const api = useApi();
  const project = useApp((st) => st.projects.find((p) => p.id === projectId));
  const keysHere = useApp((st) => (project ? st.envKeys.projects[project.root] : st.envKeys.global));
  const [rows, setRows] = useState<EnvRow[] | undefined>(undefined);
  const [dotenv, setDotenv] = useState(false);
  const [dotenvVars, setDotenvVars] = useState<readonly EnvVar[]>([]);
  const [dotenvFiles, setDotenvFiles] = useState<readonly string[]>([]);
  const [copying, setCopying] = useState(false);
  const [claudeDotenv, setClaudeDotenv] = useState(false);
  const [newKeysBack, setNewKeysBack] = useState(true);
  const [overridden, setOverridden] = useState<Readonly<Record<string, readonly string[]>>>({});
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const [shownFile, setShownFile] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [focusId, setFocusId] = useState<{ id: number; field: 'key' | 'value'; caret?: number } | undefined>(undefined);
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
      setDotenvVars(scope.dotenvVars ?? []);
      setDotenvFiles(scope.dotenvFiles ?? []);
      setClaudeDotenv(scope.claudeDotenv);
      setNewKeysBack(scope.newKeysBack ?? true);
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
    setFocusId({ id: row.id, field: 'key' });
  };
  // Typing over a .env value: it's set here from now on (and wins), the caret kept where you type.
  const override = (key: string, value: string, caret: number | null): void => {
    const row = withIds([{ key, value }])[0]!;
    editing.current = true;
    setStatus({ kind: 'idle' });
    if (shownFile.has(key)) setShown((set) => new Set([...set, row.id]));
    setRows((rs) => [...(rs ?? []), row]);
    setFocusId({ id: row.id, field: 'value', ...(caret !== null ? { caret } : {}) });
  };
  const copyIn = (): void => {
    setCopying(true);
    api.env.importDotenv(projectId).then(
      (n) => {
        setCopying(false);
        setStatus(n ? { kind: 'saved' } : { kind: 'error', text: 'They’re all in Beluga already' });
      },
      (err: unknown) => {
        setCopying(false);
        setStatus({ kind: 'error', text: errorText(err) });
      },
    );
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
  const fromFile = new Map(projectId && dotenv ? dotenvVars.map((v) => [v.key, v.value]) : []);
  const own = new Set(rows.map((r) => r.key));
  // The .env's own rows: only those not set here (a set one shows above, marked as winning over it).
  const fileRows = [...fromFile].filter(([key]) => !own.has(key));
  const notCopied = dotenvVars.filter((v) => !own.has(v.key)).length;
  // One list, in the .env's order: a value changed here stays in its place (only its tag changes); ones set only here follow.
  type Listed = { kind: 'file'; key: string; value: string } | { kind: 'own'; row: EnvRow; index: number };
  const byKey = new Map(rows.map((row, index) => [row.key, { kind: 'own' as const, row, index }]));
  const listed: Listed[] = [
    ...[...fromFile].map(([key, value]): Listed => byKey.get(key) ?? { kind: 'file', key, value }),
    ...rows.map((row, index): Listed => ({ kind: 'own', row, index })).filter((x) => !(x.kind === 'own' && fromFile.has(x.row.key))),
  ];
  const filesLabel = dotenvFiles.length ? dotenvFiles.join(' and ') : '.env';

  return (
    <>
      <Group>
        {projectId ? (
          <div className={e.sourceBar}>
            <Icon name="file" size={12} className={e.sourceIcon} />
            <span className={e.sourceText}>
              Include the main folder’s {filesLabel}
              <span className={e.muted}>
                {dotenv ? (dotenvVars.length ? ` · ${dotenvVars.length} variable${dotenvVars.length === 1 ? '' : 's'}, read fresh each time something starts` : ' · none there yet') : ' · off: only the variables set here'}
              </span>
            </span>
            <Switch
              label="Use the main folder's .env"
              on={dotenv}
              onChange={(v) => {
                setDotenv(v);
                commit(rows, v);
              }}
            />
          </div>
        ) : null}
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
        {rows.length || fileRows.length ? null : <div className={e.empty}>{projectId ? 'No variables yet, and no .env in the main folder. Add one, or paste a few KEY=value lines.' : 'No variables yet. Add one, or paste a few KEY=value lines.'}</div>}
        {listed.map((item) => {
          if (item.kind === 'file') {
            const { key, value } = item;
            const hidden = !showAll && !shownFile.has(key);
            return (
              <div key={`file:${key}`} className={e.row}>
                <input className={cx(e.key, e.fixedKey)} aria-label="Name" value={key} readOnly tabIndex={-1} />
                <input
                  className={cx(e.value, hidden && value && e.masked)}
                  aria-label={`Value of ${key} (from ${filesLabel}; typing sets it in Beluga)`}
                  value={value}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={(ev) => override(key, ev.target.value, ev.target.selectionStart)}
                />
                <button type="button" className={cx(e.eye, !hidden && e.eyeOn)} aria-label={hidden ? `Show ${key}` : `Hide ${key}`} aria-pressed={!hidden} disabled={showAll} onClick={() => setShownFile((set) => (set.has(key) ? new Set([...set].filter((x) => x !== key)) : new Set([...set, key])))}>
                  <Icon name="eye" size={13} />
                </button>
                <Tip label={`From the main folder’s ${filesLabel}. Type over it to change it here; the file stays as it is.`}>
                  <span className={e.sourceTag}>.env</span>
                </Tip>
              </div>
            );
          }
          const { row: r, index: i } = item;
          const fileValue = fromFile.get(r.key);
          const overrides = fileValue !== undefined;
          return (
            <div key={r.id} className={cx(e.row, problems.has(i) && e.bad)}>
              <input
                className={cx(e.key, overrides && e.fixedKey)}
                aria-label="Name"
                aria-invalid={problems.has(i)}
                value={r.key}
                placeholder="NAME"
                spellCheck={false}
                autoComplete="off"
                readOnly={overrides}
                tabIndex={overrides ? -1 : undefined}
                autoFocus={focusId?.id === r.id && focusId.field === 'key'}
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
                autoFocus={focusId?.id === r.id && focusId.field === 'value'}
                onFocus={(ev) => {
                  if (focusId?.id !== r.id || focusId.field !== 'value') return;
                  const at = focusId.caret ?? ev.currentTarget.value.length;
                  ev.currentTarget.setSelectionRange(at, at);
                  setFocusId(undefined);
                }}
                onChange={(ev) => change(r.id, { value: ev.target.value })}
                onBlur={() => commit(rows)}
              />
              <button type="button" className={cx(e.eye, !masked(r.id) && e.eyeOn)} aria-label={masked(r.id) ? `Show ${r.key || 'value'}` : `Hide ${r.key || 'value'}`} aria-pressed={!masked(r.id)} disabled={showAll} onClick={() => setShown((set) => (set.has(r.id) ? new Set([...set].filter((x) => x !== r.id)) : new Set([...set, r.id])))}>
                <Icon name="eye" size={13} />
              </button>
              {overrides ? (
                <Tip label={`Changed here, over the main folder’s ${filesLabel}. Click to use the file’s value again.`}>
                  <button type="button" className={cx(e.sourceTag, e.sourceEdited)} aria-label={`Use ${filesLabel} for ${r.key}`} onClick={() => remove(r.id)}>
                    <Icon name="refresh" size={10} />
                  </button>
                </Tip>
              ) : (
                <button type="button" className={e.remove} aria-label={`Remove ${r.key || 'this row'}`} onClick={() => remove(r.id)}>
                  <Icon name="x" size={10} />
                </button>
              )}
              {problems.has(i) ? <div className={e.problem}>{problems.get(i)}</div> : null}
              {!problems.has(i) && overrides ? (
                <div className={e.override}>
                  {fileValue === r.value ? `Set here, same as the ${filesLabel}.` : `Changed here. The ${filesLabel} file is left as it is.`}{' '}
                  <button type="button" className={e.inlineLink} onClick={() => remove(r.id)}>
                    Use {filesLabel}
                  </button>
                </div>
              ) : null}
              {!problems.has(i) && overridden[r.key]?.length ? (
                <div className={e.override}>
                  Not used in {overridden[r.key]!.join(', ')}: {overridden[r.key]!.length > 1 ? 'they set' : 'it sets'} {r.key} too, and that wins. Change it there.
                </div>
              ) : null}
            </div>
          );
        })}
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
          {projectId && dotenv && notCopied ? (
            <Tip label="Copies the .env values into Beluga, so they stay even if the file changes or goes">
              <Button size="small" variant="quiet" icon="download" disabled={copying} onClick={copyIn}>
                {copying ? 'Copying…' : 'Keep a Copy in Beluga'}
              </Button>
            </Tip>
          ) : null}
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
        <Group title="Worktrees">
          <Row label="New keys go to the main folder" detail="A key a worktree adds to its .env (one the main folder doesn’t have) is added there too, so the next worktree works. A changed value is asked about: copy it there, or save it in Beluga.">
            <Switch
              label="New keys from worktrees go to the main folder's .env"
              on={newKeysBack}
              onChange={(v) => {
                setNewKeysBack(v);
                api.env.newKeysBack(projectId, v).then(
                  () => setStatus({ kind: 'saved' }),
                  (err: unknown) => {
                    setNewKeysBack(!v);
                    setStatus({ kind: 'error', text: errorText(err) });
                  },
                );
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
              ? 'In this project, and it gets the .env values above too. Off: it asks you each time it wants one. A friend’s request never gets them.'
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
      <EnvEditor key={scope} projectId={scope} />
    </>
  );
}
