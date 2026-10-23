import { useState } from 'react';
import type { Template } from '@beluga/core/work-store.js';
import { Alert } from '../../components/Alert.js';
import { Checkbox, Field, FormSheet, TextArea, TextInput, formStyles as f } from '../../components/FormSheet.js';
import { Icon } from '../../components/Icon.js';
import { useApi, useApp, useBeluga } from '../../lib/beluga.js';
import { openSheet } from '../../lib/sheets.js';
import type { NativeMenuProps } from './index.js';
import { usePick } from './pick.js';
import s from './menus.module.css';

/** A template's prompt with its blanks (two spaces, ": .", "# ", a trailing space) shown as "…". */
export const withBlanks = (prompt: string): string =>
  prompt
    .replace(/: \./, ': …')
    .replace(/ {2}/, ' … ')
    .replace(/# /, '#… ')
    .replace(/ $/, ' …')
    .trim() || '…';

/** Using a template is the same option whichever way the list is open. */
const PICKER = { kind: 'templates' } as const;

/**
 * Templates: click one to start from it (it fills the message box, ready to finish and send).
 * In "manage" your own ones can be removed; New Template… makes one.
 */
export function TemplatesSheet({ menu, close }: NativeMenuProps<'templates'>) {
  const { ui } = useBeluga();
  const pick = usePick(menu);
  const use = usePick(PICKER);
  const templates = useApp((st) => st.templates);
  const [removing, setRemoving] = useState<Template>();
  const manage = Boolean(menu.manage);
  if (removing) {
    return (
      <Alert
        icon="wand"
        tone="caution"
        title={`Remove the template “${removing.name}”?`}
        message="It’s gone from the list for good. Workspaces you started with it are not affected."
        confirm={{ label: 'Remove', destructive: true, onClick: () => (setRemoving(undefined), pick(`tpl-del:${removing.id}`)) }}
        onCancel={() => setRemoving(undefined)}
      />
    );
  }
  const footer = (
    <>
      <button type="button" className={f.linkButton} onClick={() => (close(), openSheet({ kind: 'template' }))}>
        New Template…
      </button>
      {manage ? null : (
        <button type="button" className={f.linkButton} onClick={() => ui.openMenu({ kind: 'templates', manage: true })}>
          Manage
        </button>
      )}
    </>
  );
  return (
    <FormSheet
      title={manage ? 'Templates' : 'Start from a Template'}
      icon="wand"
      intro={manage ? 'Ways to start a task. Click one to use it; your own ones can be removed.' : 'It fills the message box, ready to finish and send.'}
      submitLabel=""
      hideSubmit
      cancelLabel={manage ? 'Done' : 'Cancel'}
      onSubmit={() => undefined}
      onCancel={close}
      footer={footer}
      width={560}
    >
      <div className={s.templates} role="list" aria-label="Templates">
        {templates.map((t) => (
          <div key={t.id} role="listitem" style={{ display: 'flex', alignItems: 'flex-start' }}>
            <button type="button" className={s.template} onClick={() => use(`tpl:${t.id}`)} data-autofocus={t === templates[0] ? true : undefined}>
              <span className={s.templateIcon} aria-hidden="true">
                <Icon name="wand" size={15} />
              </span>
              <span className={s.templateText}>
                <span className={s.templateName}>
                  {t.name}
                  {t.plan ? <span className={s.badge}>Plans first</span> : null}
                  {t.builtIn ? null : <span className={`${s.badge} ${s.badgeMuted}`}>Yours</span>}
                </span>
                <span className={s.templatePrompt}>{withBlanks(t.prompt)}</span>
              </span>
            </button>
            {manage && !t.builtIn ? (
              <button type="button" className={s.remove} aria-label={`Remove ${t.name}`} title="Remove" onClick={() => setRemoving(t)}>
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </FormSheet>
  );
}

/** Save a new template: its name, what Claude should do, and whether it plans first. */
export function TemplateEditorSheet({ close }: { close: () => void }) {
  const api = useApi();
  const names = useApp((st) => st.templates);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [plan, setPlan] = useState(false);
  const taken = names.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  const builtIn = taken?.builtIn === true;
  return (
    <FormSheet
      title="New Template"
      icon="wand"
      intro="A way to start a task you do often. It shows up when you start a worktree or a chat."
      submitLabel={taken && !builtIn ? 'Replace' : 'Save Template'}
      canSubmit={Boolean(name.trim() && prompt.trim()) && !builtIn}
      onSubmit={() => {
        // The core reads "name: prompt"; a colon in the name would end it early.
        void api.workbench.saveTemplate(`${name.trim().replace(/:/g, ' ')}: ${prompt.trim()}`, plan);
        close();
      }}
      onCancel={close}
      width={560}
    >
      <Field label="Name" htmlFor="tpl-name" error={builtIn ? 'A built-in template has this name. Pick another one.' : undefined} hint={taken ? 'You have a template with this name: saving replaces it.' : undefined}>
        <TextInput id="tpl-name" value={name} onChange={setName} placeholder="Fix a flaky test" maxLength={60} invalid={builtIn} />
      </Field>
      <Field label="Prompt" htmlFor="tpl-prompt" hint="What Claude should do. Leave two spaces where the details go: the cursor starts there.">
        <TextArea id="tpl-prompt" value={prompt} onChange={setPrompt} rows={5} placeholder="Find out why this test fails now and then, make it reliable, and run it 20 times to be sure." />
      </Field>
      <Field label="">
        <Checkbox checked={plan} onChange={setPlan} label="Plan first" detail="Claude shows you a plan and waits for your OK before changing anything" />
      </Field>
    </FormSheet>
  );
}
