import { motion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cx } from '../components/ui.js';
import { Select, Switch } from '../dialogs/settings-controls.js';
import { useApi, useApp } from '../lib/klaud.js';
import { ACCENTS, type Accent, type UiPrefs, setPrefs, usePrefs } from '../lib/prefs.js';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import { Glass } from './Glass.js';
import s from './onboarding.module.css';

type Appearance = UiPrefs['appearance'];

/** A tiny Klaud window in one look: sidebar, a conversation, the box you type in. */
function MiniApp({ look }: { readonly look: 'light' | 'dark' }) {
  return (
    <span className={s.mini} data-look={look}>
      <span className={s.miniSide}>
        <i />
        <i />
        <i data-on />
        <i />
      </span>
      <span className={s.miniMain}>
        <i data-w="70" />
        <i data-w="45" data-claude />
        <i data-w="58" />
        <span className={s.miniBox} />
      </span>
    </span>
  );
}

const LOOKS: ReadonlyArray<{ value: Appearance; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

/** Pick a look: three windows to choose from, and the accent. It all applies as you pick. */
export function Look() {
  const prefs = usePrefs();
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="Make it yours." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Pick a look. It changes as you choose, and Settings has it whenever you want another.
      </Rise>
      <div className={s.looks} role="radiogroup" aria-label="Appearance">
        {LOOKS.map((l, i) => {
          const on = prefs.appearance === l.value;
          return (
            <motion.button
              key={l.value}
              type="button"
              role="radio"
              aria-checked={on}
              className={cx(s.lookCard, on && s.lookOn)}
              onClick={() => setPrefs({ appearance: l.value })}
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              whileHover={{ y: -3 }}
              transition={{ ...SPRING, delay: 0.25 + i * 0.07 }}
            >
              {l.value === 'system' ? (
                <span className={s.split}>
                  <MiniApp look="light" />
                  <MiniApp look="dark" />
                </span>
              ) : (
                <MiniApp look={l.value} />
              )}
              <span className={s.lookLabel}>
                <span className={s.radio}>{on ? <motion.span layoutId="look-dot" className={s.radioDot} transition={SPRING} /> : null}</span>
                {l.label}
              </span>
            </motion.button>
          );
        })}
      </div>
      <Rise delay={0.5} className={s.accentRow}>
        <span className={s.label}>Accent</span>
        <div className={s.swatches} role="radiogroup" aria-label="Accent">
          {(Object.keys(ACCENTS) as Accent[]).map((a) => (
            <motion.button
              key={a}
              type="button"
              role="radio"
              aria-label={a === 'system' ? 'System accent' : a}
              aria-checked={prefs.accent === a}
              className={s.swatch}
              style={{ background: a === 'system' ? 'conic-gradient(#3b82f6, #8b5cf6, #e11d48, #d97706, #059669, #3b82f6)' : ACCENTS[a] }}
              onClick={() => setPrefs({ accent: a })}
              whileHover={{ scale: 1.15 }}
              whileTap={{ scale: 0.92 }}
            >
              {prefs.accent === a ? <motion.span layoutId="accent-ring" className={s.swatchRing} transition={SPRING} /> : null}
            </motion.button>
          ))}
        </div>
      </Rise>
    </div>
  );
}

/** A choice of two or three, the selection sliding between them. */
function Choice<T extends string>({ label, value, options, onChange }: { readonly label: string; readonly value: T; readonly options: ReadonlyArray<{ value: T; label: string }>; readonly onChange: (v: T) => void }) {
  return (
    <div className={s.choice} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(s.choiceItem, value === o.value && s.choiceOn)} onClick={() => onChange(o.value)}>
          {value === o.value ? <motion.span layoutId={`choice-${label}`} className={s.choicePill} transition={SPRING} /> : null}
          <span className={s.choiceLabel}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function SetupRow({ label, detail, children, index }: { readonly label: string; readonly detail: ReactNode; readonly children: ReactNode; readonly index: number }) {
  return (
    <motion.div className={s.row} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE_OUT, delay: 0.25 + index * 0.06 }}>
      <div className={s.rowText}>
        <span className={s.rowLabel}>{label}</span>
        <span className={s.rowDetail}>{detail}</span>
      </div>
      <div className={s.rowControl}>{children}</div>
    </motion.div>
  );
}

/**
 * The few settings that matter on day one, already set the way most people want them. Each
 * applies as you change it; Settings has every one of them later.
 */
export function Setup() {
  const api = useApi();
  const prefs = usePrefs();
  const self = useApp((st) => st.self?.name ?? '');
  const policy = useApp((st) => st.policy);
  const core = useApp((st) => st.prefs);
  const models = useApp((st) => st.models);
  const [name, setName] = useState(self);
  // What's typed is saved on Return, on leaving the field, and when the step goes (⌘] doesn't blur).
  const typed = useRef({ name, self });
  typed.current = { name, self };
  const saveName = (): void => {
    const next = typed.current.name.trim();
    if (next && next !== typed.current.self) void api.session.rename(next);
  };
  useEffect(() => saveName, []);
  return (
    <div className={s.setup}>
      <h2 className={s.title}>
        <Words text="A few good defaults." />
      </h2>
      <Rise delay={0.2} className={s.body}>
        Already set to what works best for most people. Change anything now, or later in Settings.
      </Rise>
      <Glass radius={16} width="100%" className={s.rows}>
        <SetupRow index={0} label="Your name" detail="What friends see when you work together.">
          <input className={s.input} aria-label="Your name" value={name} placeholder="Your name" maxLength={64} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => e.key === 'Enter' && saveName()} />
        </SetupRow>
        <SetupRow index={1} label="When a friend asks your Claude" detail={policy === 'ask' ? 'Recommended: you see and approve every request.' : policy === 'auto' ? 'Requests from friends run without asking.' : 'Only you can use your Claude.'}>
          <Choice
            label="Friends' requests"
            value={policy}
            onChange={(v) => void api.session.setClaudeSharing(v)}
            options={[
              { value: 'ask', label: 'Ask Me' },
              { value: 'auto', label: 'Allow' },
              { value: 'deny', label: 'Private' },
            ]}
          />
        </SetupRow>
        <SetupRow index={2} label="Tell me when Claude needs me" detail={core.notify.onlyAway ? 'When a run finishes or waits for you, while you’re in another app.' : 'When a run finishes or waits for you.'}>
          <Switch label="Notifications" on={core.notify.desktop} onChange={(v) => void api.session.setPrefs({ notify: { ...core.notify, desktop: v, ...(v ? { onlyAway: true } : {}) } })} />
        </SetupRow>
        <SetupRow index={3} label="Ask before my Claude runs commands" detail="Off lets Claude work on its own in your worktrees. Secrets stay blocked either way.">
          <Switch label="Ask before running commands" on={core.selfApproval === 'ask'} onChange={(v) => void api.session.setPrefs({ selfApproval: v ? 'ask' : 'never' })} />
        </SetupRow>
        {models.length ? (
          <SetupRow index={4} label="Model for new conversations" detail="Each conversation can pick its own.">
            <Select label="Model" value={core.model ?? ''} onChange={(v) => void api.workbench.setModel(undefined, v)} options={models.map((m) => ({ value: m.value, label: m.label }))} />
          </SetupRow>
        ) : null}
        <SetupRow index={5} label="Send messages with" detail={prefs.sendWith === 'enter' ? 'Shift-Return makes a new line.' : 'Return makes a new line.'}>
          <Choice
            label="Send with"
            value={prefs.sendWith}
            onChange={(v) => setPrefs({ sendWith: v })}
            options={[
              { value: 'enter', label: 'Return' },
              { value: 'cmd-enter', label: '⌘ Return' },
            ]}
          />
        </SetupRow>
      </Glass>
    </div>
  );
}
