import * as Dialog from '@radix-ui/react-dialog';
import { type ReactNode, useState } from 'react';
import { TRUST_INFO, trustOf } from '@klaud/core/trust.js';
import { EFFORTS, TRUST_LEVELS, type TrustLevel } from '@klaud/shared/settings-schema.js';
import { HIDEABLE_BUTTONS, TUNNEL_LABELS, TUNNEL_ORDER } from '@klaud/ui/settings-menus.js';
import { Icon, type IconName } from '../components/Icon.js';
import { Avatar, Button, cx } from '../components/ui.js';
import { APP_VERSION } from '../lib/boot.js';
import { type SettingsPane, useApi, useApp, useKlaud, useUi } from '../lib/klaud.js';
import { ACCENTS, type Accent, setPrefs, usePrefs } from '../lib/prefs.js';
import s from './settings.module.css';

const PANES: ReadonlyArray<{ id: SettingsPane; label: string; icon: IconName }> = [
  { id: 'general', label: 'General', icon: 'gear' },
  { id: 'appearance', label: 'Appearance', icon: 'eye' },
  { id: 'claude', label: 'Claude', icon: 'spark' },
  { id: 'notifications', label: 'Notifications', icon: 'bell' },
  { id: 'workspaces', label: 'Workspaces', icon: 'branch' },
  { id: 'people', label: 'People & access', icon: 'people' },
  { id: 'about', label: 'About', icon: 'globe' },
];

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={cx(s.switch, on && s.switchOn)} onClick={() => onChange(!on)} />;
}

function Select<T extends string>({ value, options, onChange, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <select className={s.select} value={value} aria-label={label} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Row({ label, detail, children }: { label: string; detail?: ReactNode; children: ReactNode }) {
  return (
    <div className={s.row}>
      <div className={s.rowText}>
        <div className={s.rowLabel}>{label}</div>
        {detail ? <div className={s.rowDetail}>{detail}</div> : null}
      </div>
      <div className={s.control}>{children}</div>
    </div>
  );
}

function Group({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className={s.group}>
      {title ? <h3 className={s.groupTitle}>{title}</h3> : null}
      <div className={s.groupBox}>{children}</div>
    </section>
  );
}

function General() {
  const api = useApi();
  const state = useApp((st) => st);
  const prefs = usePrefs();
  const [name, setName] = useState(state.self?.name ?? '');
  return (
    <>
      <Group>
        <Row label="Your name" detail="What friends see in the room.">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void api.session.rename(name);
            }}
          >
            <input className={s.text} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== state.self?.name && void api.session.rename(name)} />
          </form>
        </Row>
        <Row label="Friends' requests for your Claude" detail="For people you haven't picked a trust level for.">
          <Select
            label="Default policy"
            value={state.policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask me each time' },
              { value: 'auto', label: 'Allow everyone' },
              { value: 'deny', label: 'Keep it private' },
            ]}
          />
        </Row>
      </Group>
      <Group title="Writing">
        <Row label="Send with" detail={prefs.sendWith === 'enter' ? 'Shift+Return makes a new line.' : 'Return makes a new line.'}>
          <Select
            label="Send with"
            value={prefs.sendWith}
            onChange={(v) => setPrefs({ sendWith: v })}
            options={[
              { value: 'enter', label: 'Return' },
              { value: 'cmd-enter', label: '⌘ Return' },
            ]}
          />
        </Row>
        <Row label="Show times next to messages">
          <Switch label="Times" on={prefs.timestamps} onChange={(v) => setPrefs({ timestamps: v })} />
        </Row>
        <Row label="Claude's steps in the chat" detail="Finished runs keep their last few steps either way.">
          <Select
            label="Steps"
            value={prefs.steps}
            onChange={(v) => setPrefs({ steps: v })}
            options={[
              { value: 'all', label: 'Show them' },
              { value: 'summary', label: 'Only while it works' },
            ]}
          />
        </Row>
      </Group>
    </>
  );
}

function Appearance() {
  const prefs = usePrefs();
  return (
    <>
      <Group>
        <Row label="Appearance">
          <Select
            label="Appearance"
            value={prefs.appearance}
            onChange={(v) => setPrefs({ appearance: v })}
            options={[
              { value: 'system', label: 'Match the system' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Accent" detail="Selection, focus and buttons. “System” follows your Mac.">
          <div className={s.swatches}>
            {(Object.keys(ACCENTS) as Accent[]).map((a) => (
              <button key={a} type="button" aria-label={a} aria-pressed={prefs.accent === a} className={cx(s.swatch, prefs.accent === a && s.swatchOn)} style={{ background: a === 'system' ? 'conic-gradient(#3b82f6, #8b5cf6, #e11d48, #d97706, #059669, #3b82f6)' : ACCENTS[a] }} onClick={() => setPrefs({ accent: a })} />
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Layout">
        <Row label="Text size" detail={`${prefs.textSize} pt · ⌘+ and ⌘− work anywhere`}>
          <input className={s.slider} type="range" min={11} max={17} step={1} value={prefs.textSize} onChange={(e) => setPrefs({ textSize: Number(e.target.value) })} />
        </Row>
        <Row label="Density">
          <Select
            label="Density"
            value={prefs.density}
            onChange={(v) => setPrefs({ density: v })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
        <Row label="Conversation width">
          <Select
            label="Width"
            value={prefs.chatWidth}
            onChange={(v) => setPrefs({ chatWidth: v })}
            options={[
              { value: 'narrow', label: 'Narrow' },
              { value: 'wide', label: 'Wide' },
              { value: 'full', label: 'Full window' },
            ]}
          />
        </Row>
        <Row label="Sidebar width">
          <input className={s.slider} type="range" min={200} max={360} step={4} value={prefs.sidebarWidth} onChange={(e) => setPrefs({ sidebarWidth: Number(e.target.value) })} />
        </Row>
        <Row label="Reduce motion">
          <Switch label="Reduce motion" on={prefs.reduceMotion} onChange={(v) => setPrefs({ reduceMotion: v })} />
        </Row>
      </Group>
    </>
  );
}

function ClaudePane() {
  const api = useApi();
  const { ui } = useKlaud();
  const state = useApp((st) => st);
  const p = state.prefs;
  return (
    <>
      <Group>
        <Row label="Model for new conversations" detail="Each conversation can pick its own from the box you type in.">
          <Select label="Model" value={p.model ?? ''} onChange={(v) => void api.workbench.setModel(undefined, v)} options={state.models.map((m) => ({ value: m.value, label: m.label }))} />
        </Row>
        <Row label="Thinking effort">
          <Select label="Effort" value={p.effort ?? ''} onChange={(v) => void api.session.setPrefs({ effort: (v || undefined) as (typeof EFFORTS)[number] | undefined })} options={[{ value: '', label: 'Default' }, ...EFFORTS.map((e) => ({ value: e, label: e[0]!.toUpperCase() + e.slice(1) }))]} />
        </Row>
        <Row label="Ask before running commands" detail="Your own Claude. Secrets stay blocked either way.">
          <Switch label="Self approval" on={p.selfApproval === 'ask'} onChange={(v) => void api.session.setPrefs({ selfApproval: v ? 'ask' : 'never' })} />
        </Row>
      </Group>
      <Group title="In the chat">
        <Row label="Sub-agents">
          <Select
            label="Sub-agents"
            value={p.subagents}
            onChange={(v) => void api.session.setPrefs({ subagents: v })}
            options={[
              { value: 'full', label: 'Every step' },
              { value: 'compact', label: 'One line each' },
              { value: 'hidden', label: 'Just a count' },
            ]}
          />
        </Row>
        <Row label="Context meter" detail="How full each conversation is, next to its name.">
          <Switch label="Context meter" on={p.contextMeter} onChange={(v) => void api.session.setPrefs({ contextMeter: v })} />
        </Row>
      </Group>
      <Group title="Pull requests and templates">
        <Row label="Pull request instructions" detail={state.prCustom ? 'Customized' : 'Built-in'}>
          <Button onClick={() => void api.workbench.editPrPrompt()}>Edit…</Button>
          {state.prCustom ? (
            <Button variant="quiet" onClick={() => void api.workbench.resetPrPrompt()}>
              Reset
            </Button>
          ) : null}
        </Row>
        <Row label="Templates" detail={`${state.templates.length} ways to start a task`}>
          <Button onClick={() => ui.patch({ settings: undefined, menu: { menu: { kind: 'templates', manage: true }, selected: 0 } })}>Manage…</Button>
        </Row>
      </Group>
    </>
  );
}

function Notifications() {
  const api = useApi();
  const n = useApp((st) => st.prefs.notify);
  const set = (key: keyof typeof n, v: boolean): void => void api.session.setPrefs({ notify: { ...n, [key]: v } });
  const kinds: ReadonlyArray<[keyof typeof n, string, string]> = [
    ['done', 'Claude finished', 'In a conversation you’re not looking at'],
    ['needsYou', 'Claude needs you', 'A question, a plan, or an approval'],
    ['problems', 'Problems', 'Errors, merge conflicts, failed setups'],
    ['people', 'People', 'Someone joins, invites you, or hands work to you'],
    ['pr', 'Pull requests', 'Opened, checks finished, reviewed'],
  ];
  return (
    <>
      <Group>
        <Row label="Desktop notifications" detail="The inbox fills either way.">
          <Switch label="Desktop" on={n.desktop} onChange={(v) => set('desktop', v)} />
        </Row>
        <Row label="Sound">
          <Switch label="Sound" on={n.sound} onChange={(v) => set('sound', v)} />
        </Row>
        <Row label="Try it">
          <Button onClick={() => void api.session.testNotification()}>Send a test</Button>
        </Row>
      </Group>
      <Group title="Tell me when">
        {kinds.map(([key, label, detail]) => (
          <Row key={key} label={label} detail={detail}>
            <Switch label={label} on={n[key]} onChange={(v) => set(key, v)} />
          </Row>
        ))}
      </Group>
    </>
  );
}

function Workspaces() {
  const api = useApi();
  const p = useApp((st) => st.prefs);
  const [shell, setShell] = useState(p.shell ?? '');
  return (
    <>
      <Group>
        <Row label="Run setup in new worktrees" detail="The project's setup command (npm install, …) runs in each new worktree.">
          <Switch label="Auto setup" on={p.autoSetup} onChange={(v) => void api.session.setPrefs({ autoSetup: v })} />
        </Row>
        <Row label="Friends may start work here" detail="They ask to start a worktree or hand work to you; you approve each one.">
          <Switch label="Friend worktrees" on={p.friendWorktrees === 'ask'} onChange={(v) => void api.session.setFriendWorktrees(v ? 'ask' : 'off')} />
        </Row>
        <Row label="Terminal shell" detail="Empty: your login shell.">
          <input className={s.text} value={shell} placeholder="/bin/zsh" onChange={(e) => setShell(e.target.value)} onBlur={() => void api.session.setPrefs({ shell: shell || undefined })} />
        </Row>
      </Group>
      <Group title="Toolbar buttons">
        {HIDEABLE_BUTTONS.map(([id, label]) => (
          <Row key={id} label={label}>
            <Switch label={label} on={!p.hiddenButtons.includes(id)} onChange={(v) => void api.session.setPrefs({ hiddenButtons: v ? p.hiddenButtons.filter((b) => b !== id) : [...p.hiddenButtons, id] })} />
          </Row>
        ))}
      </Group>
    </>
  );
}

function People() {
  const api = useApi();
  const state = useApp((st) => st);
  const others = state.peers.filter((p) => p.peerId !== state.selfId);
  const remembered = Object.entries(state.remembered).filter(([id]) => !others.some((p) => p.peerId === id));
  return (
    <>
      <Group title="In the room">
        {others.length ? (
          others.map((p) => (
            <Row key={p.peerId} label={p.name} detail={TRUST_INFO[trustOf(state, p.peerId)].detail}>
              <Avatar name={p.name} id={p.peerId} size={20} />
              <Select<TrustLevel> label={`Trust ${p.name}`} value={trustOf(state, p.peerId)} onChange={(v) => void api.people.setTrust(p.peerId, v)} options={TRUST_LEVELS.map((l) => ({ value: l, label: TRUST_INFO[l].label }))} />
            </Row>
          ))
        ) : (
          <div className={s.note}>Nobody else is here yet.</div>
        )}
      </Group>
      {remembered.length ? (
        <Group title="Remembered from before">
          {remembered.map(([id, r]) => (
            <Row key={id} label={r.name} detail={TRUST_INFO[r.trust].label}>
              <Button variant="quiet" onClick={() => void api.people.forget(id)}>
                Forget
              </Button>
            </Row>
          ))}
        </Group>
      ) : null}
      <Group title="Remote access">
        <Row label="How friends reach you" detail="Takes effect for the next invite.">
          <Select label="Tunnel" value={state.prefs.tunnel} onChange={(v) => void api.session.setPrefs({ tunnel: v })} options={TUNNEL_ORDER.map((t) => ({ value: t, label: TUNNEL_LABELS[t] }))} />
        </Row>
        {state.isHost ? (
          <Row label="Take new people" detail={state.roomOpen ? 'Anyone with the link can come in (or knock).' : 'Closed: nobody new can join, even with the link.'}>
            <Switch label="Room open" on={state.roomOpen} onChange={(v) => void api.session.setRoomOpen(v)} />
          </Row>
        ) : null}
        <Row label="Invite link">
          <Button onClick={() => void api.session.copyInvite()}>Copy</Button>
          {state.isHost ? (
            <Button variant="quiet" onClick={() => void api.session.newInviteLink()}>
              New link
            </Button>
          ) : null}
        </Row>
      </Group>
    </>
  );
}

function About() {
  const { client } = useKlaud();
  return (
    <Group>
      <Row label="klaud for Mac">{APP_VERSION}</Row>
      <Row label="klaud (the part that runs your room)">{client.daemonVersion}</Row>
      <Row label="Windows attached" detail="The terminal app and this one share the same room.">
        {client.clients}
      </Row>
      <Row label="Log" detail="~/.klaud/logs/daemon.log">
        <Icon name="file" size={14} />
      </Row>
    </Group>
  );
}

const BODY: Record<SettingsPane, () => ReactNode> = { general: General, appearance: Appearance, claude: ClaudePane, notifications: Notifications, workspaces: Workspaces, people: People, about: About };

/** klaud's settings: this window's look on the left panes, klaud's shared settings on the rest. */
export function Settings() {
  const { ui } = useKlaud();
  const pane = useUi((u) => u.settings);
  if (!pane) return null;
  const Body = BODY[pane];
  return (
    <Dialog.Root open onOpenChange={(v) => (v ? undefined : ui.patch({ settings: undefined }))}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={s.window} aria-describedby={undefined} onOpenAutoFocus={(e) => e.preventDefault()}>
          <nav className={s.nav}>
            <Dialog.Title className={s.title}>Settings</Dialog.Title>
            {PANES.map((p) => (
              <button key={p.id} type="button" className={cx(s.navItem, p.id === pane && s.navOn)} onClick={() => ui.patch({ settings: p.id })}>
                <Icon name={p.icon} size={14} />
                {p.label}
              </button>
            ))}
          </nav>
          <div className={s.body}>
            <div className={s.bodyHead}>
              <h2 className={s.paneTitle}>{PANES.find((p) => p.id === pane)?.label}</h2>
              <Dialog.Close className={s.close} aria-label="Close">
                <Icon name="x" size={12} />
              </Dialog.Close>
            </div>
            <div className={s.scroll}>
              <Body />
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
