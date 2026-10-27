import { useEffect, useMemo, useState } from 'react';
import type { Recipe, SentinelDraft } from '@beluga/core/sentinel/model.js';
import { Field, FormSheet, Popup, TextArea, TextInput } from '../components/FormSheet.js';
import { Segmented } from '../components/ui.js';
import { useApp } from '../lib/beluga.js';
import { projectOfView } from '../tasks/use-tasks.js';
import { Icon } from '../components/Icon.js';
import { MAC_SCOPE, describedName, iconOf, recipeWhen } from './sentinel-model.js';
import { useSentinelActions } from './use-sentinel.js';
import s from './sentinel.module.css';

type Way = 'describe' | 'recipe' | 'build';

const WAYS: ReadonlyArray<{ readonly value: Way; readonly label: string; readonly icon: 'claude' | 'wand' | 'wrench'; readonly hint: string }> = [
  { value: 'describe', label: 'Describe it', icon: 'claude', hint: 'Say what it should do; Claude writes it' },
  { value: 'recipe', label: 'Recipe', icon: 'wand', hint: 'Start from one that works, then change anything' },
  { value: 'build', label: 'Build it yourself', icon: 'wrench', hint: 'A name and a project; you add when it runs and its steps' },
];

/**
 * New Sentinel: three ways in, as the project home's composer offers them. Describe it makes an
 * empty, paused sentinel and asks your Claude to fill it in (the page opens and shows it working);
 * a recipe makes one filled in (paused) and opens its page; Build it yourself makes an empty one
 * that runs when you press Run. Every new sentinel starts paused.
 */
export function NewSentinelSheet({ projectId, way: first = 'describe', close }: { projectId?: string; way?: Way; close: () => void }) {
  const a = useSentinelActions();
  const all = useApp((st) => st.projects);
  const inView = useApp(projectOfView);
  const projects = useMemo(() => all.filter((p) => p.root && !p.error), [all]);
  // The project you're in (or the list's); anywhere else Your Mac, first in the list: a sentinel can work on the Mac itself.
  const start = projectId === MAC_SCOPE || projects.some((p) => p.id === projectId) ? projectId! : (inView ?? MAC_SCOPE);
  const [project, setProject] = useState<string>(start ?? MAC_SCOPE);
  const [way, setWay] = useState<Way>(first);
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [recipes, setRecipes] = useState<readonly Recipe[]>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    let alive = true;
    void a.act(() => a.api.recipes()).then((r) => alive && setRecipes(r ?? []));
    return () => {
      alive = false;
    };
  }, [a]);

  const where = project === MAC_SCOPE ? null : project;
  const make = async (draft: SentinelDraft): Promise<string | void> => {
    const made = await a.act(() => a.create({ ...draft, projectId: where }));
    if (!made) return 'Couldn’t make it: see the message above';
    close();
    a.open(made.id);
  };
  /** Describe it: an empty, paused sentinel, then your Claude fills it in from the words. */
  const describe = async (): Promise<string | void> => {
    const text = words.trim();
    if (!text) return;
    const made = await a.act(() => a.create({ name: describedName(text), projectId: where, trigger: { kind: 'manual' }, steps: [] }));
    if (!made) return 'Couldn’t make it: see the message above';
    close();
    a.open(made.id);
    await a.act(() => a.api.ask(made.id, text));
  };
  /** A recipe: its sentinel filled in (paused), and the one that runs after it when it has one. */
  const pick = async (r: Recipe): Promise<void> => {
    if (busy) return;
    setBusy(r.id);
    const made = await a.act(() => a.create({ ...r.sentinel, projectId: where }));
    if (made && r.then) await a.act(() => a.create({ ...r.then!.sentinel, projectId: where, trigger: { kind: 'after', sentinelId: made.id, on: r.then!.on } }));
    setBusy(undefined);
    if (!made) return;
    close();
    a.open(made.id);
  };

  const projectName = project === MAC_SCOPE ? 'Your Mac' : projects.find((p) => p.id === project)?.name;
  return (
    <FormSheet
      title="New Sentinel"
      icon="sentinel"
      intro="A sentinel runs on a schedule or when you press Run, does its steps in order, and leaves a report. It starts paused: you look it over, then Turn It On."
      submitLabel={way === 'build' ? 'Make Sentinel' : way === 'describe' ? 'Write It' : 'Pick a Recipe'}
      canSubmit={(way === 'build' && Boolean(name.trim())) || (way === 'describe' && Boolean(words.trim()))}
      width={640}
      onCancel={close}
      onSubmit={() => (way === 'build' ? make({ name: name.trim(), trigger: { kind: 'manual' }, steps: [] }) : way === 'describe' ? describe() : undefined)}
    >
      <div className={s.sheetBody}>
        <div className={s.ways}>
          <Segmented<Way> label="How to make it" value={way} onChange={setWay} options={WAYS} />
        </div>
        <div className={s.row2}>
          <span className={s.label}>Where</span>
          <Popup
            label="Where it works"
            value={project}
            onChange={setProject}
            options={[{ value: MAC_SCOPE, label: 'Your Mac', description: 'Not tied to a project: things about the Mac itself' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          />
        </div>
        {way === 'describe' ? (
          <Field label="What should it do?" htmlFor="sentinel-words" hint={`Claude sets it up in ${projectName ?? 'Your Mac'}, looking at the project first when that helps. It starts paused: look it over, then Turn On.`}>
            <TextArea
              id="sentinel-words"
              value={words}
              onChange={setWords}
              rows={4}
              maxLength={8000}
              placeholder="Every weekday morning, read yesterday’s commits and open issues, write me a brief, and create tasks for anything that looks urgent"
              data-autofocus
              aria-label="What should it do?"
            />
          </Field>
        ) : way === 'recipe' ? (
          !recipes ? (
            <div className={s.empty}>Reading the recipes…</div>
          ) : (
            <div className={s.recipes} role="list" aria-label="Recipes">
              {recipes.map((r) => (
                <button key={r.id} type="button" role="listitem" className={s.recipe} aria-busy={busy === r.id} disabled={Boolean(busy)} onClick={() => void pick(r)} data-recipe={r.id}>
                  <Icon name={iconOf(r.icon)} size={14} />
                  <span className={s.recipeName}>{r.name}</span>
                  <span className={s.recipeWhen} title={recipeWhen(r)}>
                    {recipeWhen(r)}
                  </span>
                  <span className={s.recipeLine}>{r.line}</span>
                </button>
              ))}
            </div>
          )
        ) : (
          <Field label="Name" htmlFor="sentinel-name" hint={`In ${projectName ?? 'Your Mac'}; it runs when you press Run until you give it a schedule.`}>
            <TextInput id="sentinel-name" value={name} onChange={setName} maxLength={80} placeholder="Morning brief" data-autofocus />
          </Field>
        )}
      </div>
    </FormSheet>
  );
}
