import { EXPERIMENTS, EXPERIMENT_INFO, type Experiment, experimentOn, withExperiment } from '@beluga/shared/experiments.js';
import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Button } from '../components/ui.js';
import { useApi, useApp } from '../lib/beluga.js';
import { Group, Row, Switch } from './settings-controls.js';
import s from './settings.module.css';
import x from './experimental.module.css';

/**
 * Settings › Experimental: early features, each off until you turn it on, each saying what it
 * changes in Beluga and what it costs this computer (shared/experiments.ts). Turning one on is
 * saved with your settings, and the daemon follows it at once (what your agent is told, what it
 * may build).
 */
export function ExperimentalSettings() {
  const api = useApi();
  const enabled = useApp((st) => st.prefs.experiments);
  const set = (id: Experiment, on: boolean): void => void api.session.setPrefs({ experiments: withExperiment(enabled, id, on) });
  return (
    <>
      <div className={x.intro}>
        <Icon name="flask" size={16} className={x.introIcon} />
        <p>
          Early features we’re still shaping. They haven’t been tested as fully as the rest of Beluga, so each one is off until you turn it on, and it may change before it’s finished. Here’s what each does, and what it changes.
        </p>
      </div>
      {EXPERIMENTS.map((id) => {
        const info = EXPERIMENT_INFO[id];
        const on = experimentOn(enabled, id);
        return (
          <Group key={id} title={info.title}>
            <Row label={info.title} detail={info.summary}>
              <Switch label={info.title} on={on} onChange={(v) => set(id, v)} />
            </Row>
            {id === 'toolSearch' && on ? <ToolSearchStatus onRemove={() => set(id, false)} /> : null}
            <div className={x.about}>
              <div className={x.heading}>What changes</div>
              <ul className={x.changes}>
                {info.changes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <div className={x.heading}>On this computer</div>
              <p className={x.cost}>{info.cost}</p>
            </div>
          </Group>
        );
      })}
      <p className={s.note}>Something not right in an experiment? Report a Problem, in About, tells us.</p>
    </>
  );
}

interface ToolSearch {
  readonly state: 'idle' | 'preparing' | 'ready' | 'failed';
  readonly progress?: { readonly done: number; readonly total: number };
  readonly error?: string;
}

const mb = (bytes: number): string => `${Math.round(bytes / 1e6)} MB`;

/** Semantic tool search, once on: how far getting ready is, or that it is ready, and Remove (turns it off; the daemon deletes the files). */
function ToolSearchStatus({ onRemove }: { onRemove: () => void }) {
  const api = useApi();
  const [status, setStatus] = useState<ToolSearch>({ state: 'preparing' });
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void =>
      void api.external.toolSearch().then(
        (v) => {
          if (!live) return;
          const next = v as ToolSearch;
          setStatus(next);
          if (next.state === 'preparing' || next.state === 'idle') timer = setTimeout(poll, 1000);
        },
        () => undefined,
      );
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api]);
  const { progress } = status;
  const text =
    status.state === 'ready'
      ? 'Ready. beluga_find ranks tools by meaning.'
      : status.state === 'failed'
        ? `Couldn’t get ready: ${status.error ?? 'unknown error'}. beluga_find keeps its built-in search. Turn it off and on to try again.`
        : progress && progress.done < progress.total
          ? `Downloading: ${mb(progress.done)} of ${mb(progress.total)}`
          : 'Getting ready: reading Beluga’s tools once. This takes a minute or two.';
  return (
    <Row label="Status" detail={text}>
      {status.state === 'preparing' && progress ? <progress className={x.progress} max={progress.total} value={progress.done} aria-label="Download progress" /> : null}
      <Button tone="error" onClick={onRemove}>
        Remove
      </Button>
    </Row>
  );
}
