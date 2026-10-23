import { useState } from 'react';
import { channelOf } from '@beluga/core/store.js';
import { currentQuestion } from '@beluga/ui/collab-actions.js';
import { TRUST_INFO } from '@beluga/core/trust.js';
import { Icon } from '../components/Icon.js';
import { Button, Dot, Tip } from '../components/ui.js';
import { useActions } from '../lib/actions.js';
import { useApi, useApp, useBeluga } from '../lib/beluga.js';
import { brandText } from '../lib/brand.js';
import { Markdown } from './Markdown.js';
import { useNow } from './Items.js';
import s from './attention.module.css';

/**
 * What needs you right now, just above the box you type in: an approval, Claude's question or
 * plan, someone at the door, a new person to choose a trust level for.
 */
export function Attention() {
  // People at the door and new people to trust belong to the room; approvals reach you anywhere.
  const inRoom = useApp((st) => st.view.kind === 'room');
  return (
    <div className={s.stack}>
      <Approvals />
      <Question />
      {inRoom ? <Knock /> : null}
      {inRoom ? <TrustPrompt /> : null}
    </div>
  );
}

function Approvals() {
  const api = useApi();
  const approvals = useApp((st) => st.approvals);
  const first = approvals[0];
  const now = useNow(Boolean(first?.askedAt));
  const [showAll, setShowAll] = useState(false);
  if (!first) return null;
  const others = approvals.slice(1);
  const left = first.askedAt && first.timeoutMs ? Math.max(0, first.askedAt + first.timeoutMs - now) : undefined;
  return (
    <div className={`${s.card} ${s.urgent}`} role="alertdialog" aria-label="Approval needed">
      <div className={s.head}>
        <Dot tone="warn" />
        <span className={s.title}>{brandText(first.title)}</span>
        {others.length ? (
          <button type="button" className={s.moreButton} aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show less' : `+${others.length} more`}
            <Icon name={showAll ? 'chevronUp' : 'chevronDown'} size={10} />
          </button>
        ) : null}
        {left !== undefined ? <span className={s.countdown}>{Math.ceil(left / 60_000)} min left</span> : null}
      </div>
      {first.detail ? <pre className={`${s.detail} selectable`}>{first.detail}</pre> : null}
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void api.host.answerApproval('yes', first.id)}>
          Allow
        </Button>
        <Button onClick={() => void api.host.answerApproval('always', first.id)}>Always allow</Button>
        <Button variant="quiet" onClick={() => void api.host.answerApproval('no', first.id)}>
          Deny
        </Button>
      </div>
      {showAll && others.length ? (
        <ul className={s.others} aria-label="Also waiting for you">
          {others.map((a) => (
            <li key={a.id} className={s.other}>
              <span className={s.otherText}>
                <span className={s.otherTitle}>{brandText(a.title)}</span>
                {a.detail ? <code className={s.otherDetail}>{a.detail}</code> : null}
              </span>
              <Button size="small" onClick={() => void api.host.answerApproval('yes', a.id)}>
                Allow
              </Button>
              <Button size="small" variant="quiet" onClick={() => void api.host.answerApproval('no', a.id)}>
                Deny
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Question() {
  const actions = useActions();
  const { ui } = useBeluga();
  const state = useApp((st) => st);
  const q = state.questions[0];
  if (!q || q.channel !== channelOf(state.view)) return null;
  const owner = state.peers.find((p) => p.peerId === q.owner)?.name;
  if (q.question.kind === 'plan') {
    return (
      <div className={s.card}>
        <div className={s.head}>
          <Icon name="wand" size={13} className={s.claude} />
          <span className={s.title}>{owner && q.owner !== state.selfId ? `${owner}'s Claude` : 'Claude'} has a plan</span>
          <Button size="small" variant="quiet" onClick={() => ui.patch({ planFull: q.qid })}>
            Read in full
          </Button>
        </div>
        <div className={s.plan}>
          <Markdown text={q.question.plan} />
        </div>
        <div className={s.actions}>
          <Button variant="primary" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'approve' })}>
            Approve plan
          </Button>
          <span className={s.hint}>or type what to change below</span>
        </div>
      </div>
    );
  }
  const current = currentQuestion(q);
  if (!current) return null;
  const chosen = new Set((q.picked[`${current.question}#multi`] ?? '').split('\u0000').filter(Boolean));
  const total = q.question.questions.length;
  const index = q.question.questions.indexOf(current);
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="claude" size={13} className={s.claude} />
        <span className={s.title}>{current.header || 'Claude asks'}</span>
        {total > 1 ? <span className={s.more}>{index + 1} of {total}</span> : null}
        <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'skip' })}>
          Skip
        </Button>
      </div>
      <div className={`${s.question} selectable`}>
        <Markdown text={current.question} />
      </div>
      <div className={s.options}>
        {current.options.map((o, i) => (
          <button key={o.label} type="button" className={`${s.option} ${chosen.has(o.label) ? s.optionOn : ''}`} onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'option', label: o.label, question: current.question })}>
            <span className={s.optionKey}>{i + 1}</span>
            <span className={s.optionText}>
              <span className={s.optionLabel}>{o.label}</span>
              {o.description ? <span className={s.optionDesc}>{o.description}</span> : null}
            </span>
            {current.multiSelect ? <Icon name={chosen.has(o.label) ? 'check' : 'plus'} size={12} /> : null}
          </button>
        ))}
      </div>
      {current.multiSelect ? (
        <div className={s.actions}>
          <Button variant="primary" onClick={() => actions.run({ type: 'answer', qid: q.qid, pick: 'done', question: current.question })}>
            Done
          </Button>
        </div>
      ) : (
        <div className={s.hint}>Pick one, or type your own answer below.</div>
      )}
    </div>
  );
}

function Knock() {
  const actions = useActions();
  const state = useApp((st) => st);
  const knock = state.knocks.find((k) => state.peers.some((p) => p.peerId === k.peerId));
  if (!knock) return null;
  const who = state.peers.find((p) => p.peerId === knock.peerId)?.name ?? 'Someone';
  const link = state.links.find((l) => l.id === knock.linkId);
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="person" size={13} />
        <span className={s.title}>
          {who} wants to join {link ? link.label : 'the room'}
        </span>
      </div>
      <div className={s.actions}>
        <Button variant="primary" onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'in' })}>
          Let in
        </Button>
        <Button onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'watch' })}>Let in to watch</Button>
        <Button variant="quiet" onClick={() => actions.run({ type: 'knock', peerId: knock.peerId, pick: 'decline' })}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function TrustPrompt() {
  const actions = useActions();
  const state = useApp((st) => st);
  const peerId = state.trustPrompts.find((id) => state.peers.some((p) => p.peerId === id));
  if (!peerId) return null;
  const who = state.peers.find((p) => p.peerId === peerId)?.name ?? 'Someone';
  return (
    <div className={s.card}>
      <div className={s.head}>
        <Icon name="lock" size={13} />
        <span className={s.title}>How much do you trust {who}?</span>
        <Button size="small" variant="quiet" onClick={() => actions.run({ type: 'trust_later', peerId })}>
          Later
        </Button>
      </div>
      <div className={s.trustRow}>
        {(['ask', 'trusted', 'full', 'blocked'] as const).map((level) => (
          <Tip key={level} label={TRUST_INFO[level].detail}>
            <button type="button" className={s.trust} onClick={() => actions.run({ type: 'trust', peerId, level })}>
              <span className={s.optionLabel}>{TRUST_INFO[level].label}</span>
            </button>
          </Tip>
        ))}
      </div>
    </div>
  );
}
