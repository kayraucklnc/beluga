import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, Button } from '../components/ui.js';
import type { PopupPort } from '../gateway/popup-bridge.js';
import { POPUP_MAX, type PopupItem, type PopupNeed, type PopupRequest, isNeed, popupButtons, popupWho } from '../gateway/popup-model.js';
import type { RequestAction } from '../gateway/request-actions.js';
import s from './popup.module.css';

/**
 * A friend's request, on top of whatever you're doing: who, a few words of what they want,
 * and Allow / Allow Always / Decline. See more shows everything their Claude sent (the full
 * ask, what it needs, where it runs, what goes back) before you answer.
 */

const KIND_ICON = { ask: 'claude', run: 'terminal', file: 'file' } as const;
const NEED_ICON = { question: 'claude', decision: 'hand', plan: 'wand', approval: 'lock', milestone: 'flag' } as const;
const NEED_LEAD = { question: 'Your agent asks', decision: 'Your call', plan: 'Your agent has a plan', approval: 'Your agent needs your OK', milestone: 'Ready for you' } as const;

/**
 * Your own Claude (or a plan) needs you: what, where, and Open, which takes you there in Beluga
 * (a question's choices, your own words, the decision's card: there's room for them there).
 */
function NeedCard({ r, open, later }: { r: PopupNeed; open: () => void; later: () => void }) {
  return (
    <article className={s.card} data-testid="request-popup-card" data-need={r.tag} aria-label={`${r.title}: ${r.body}`}>
      <header className={s.head}>
        <span className={s.needMark} aria-hidden>
          <Icon name={NEED_ICON[r.tag]} size={15} />
        </span>
        <div className={s.headText}>
          <div className={s.who}>
            <strong>{NEED_LEAD[r.tag]}</strong> · {r.title}
          </div>
          <button type="button" className={s.needBody} onClick={open}>
            {r.body}
          </button>
          {r.options?.length ? <div className={s.said}>{r.options.join(' · ')}</div> : null}
        </div>
      </header>
      <footer className={s.buttons}>
        <Button size="small" variant="plain" onClick={later}>
          Later
        </Button>
        <Button size="small" variant="primary" onClick={open}>
          {r.tag === 'approval' ? 'Review in Beluga' : r.tag === 'milestone' ? 'Open the Plan' : 'Answer in Beluga'}
        </Button>
      </footer>
    </article>
  );
}

function Card({ r, act }: { r: PopupRequest; act: (action: RequestAction, r: PopupRequest) => void }) {
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const press = (action: RequestAction): void => {
    if (action === 'review') return act(action, r);
    setBusy(true);
    act(action, r);
    // Answered, the card goes; if it couldn't be (Beluga says why), the buttons come back.
    setTimeout(() => setBusy(false), 4000);
  };
  return (
    <article className={s.card} data-testid="request-popup-card" aria-label={r.secret ? `${popupWho(r)} wants ${r.secret}` : `${popupWho(r)} wants to ${r.gist}`}>
      <header className={s.head}>
        <Avatar name={r.peerName} id={r.peerId} claude={r.claude} size={30} />
        <div className={s.headText}>
          <div className={s.who}>
            <strong>{popupWho(r)}</strong> {r.secret ? 'wants' : 'wants to'}
          </div>
          <div className={s.gist}>
            <Icon name={r.secret ? 'lock' : KIND_ICON[r.kind]} size={13} />
            <span>{r.secret ?? r.gist}</span>
          </div>
          {r.secret ? <div className={s.said}>A secret: you’re asked each time, and only this one file goes.</div> : null}
          {r.said ? <div className={s.said}>{r.said}</div> : null}
        </div>
      </header>
      {r.needs.length ? (
        <div className={s.needs}>
          {r.needs.map((n) => (
            <span key={n} className={s.need}>
              {n}
            </span>
          ))}
        </div>
      ) : null}
      <button type="button" className={s.more} aria-expanded={more} onClick={() => setMore(!more)}>
        <Icon name={more ? 'chevronDown' : 'chevronRight'} size={11} />
        {more ? 'See less' : 'See more'}
      </button>
      {more ? (
        <div className={s.detail} data-testid="request-popup-detail">
          <div className={s.label}>{r.kind === 'ask' ? `What ${popupWho(r)} sends your agent` : r.kind === 'run' ? 'The command' : 'The file'}</div>
          <pre className={s.full}>{r.full}</pre>
          <dl className={s.facts}>
            <dt>Where</dt>
            <dd>{r.where}</dd>
            <dt>Sends back</dt>
            <dd>{r.back}</dd>
          </dl>
          <button type="button" className={s.link} onClick={() => press('review')}>
            Open in Beluga for more choices…
          </button>
        </div>
      ) : null}
      <footer className={s.buttons}>
        {popupButtons(r).map((b) => (
          <Button key={b.action} size="small" variant={b.action === 'approve' ? 'primary' : 'plain'} disabled={busy} onClick={() => press(b.action)}>
            {b.label}
          </Button>
        ))}
      </footer>
    </article>
  );
}

export function RequestPopup({ port }: { port: PopupPort }) {
  const [requests, setRequests] = useState<readonly PopupItem[]>([]);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => port.subscribe(setRequests), [port]);
  // The window is as tall as the cards.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = (): void => port.resize(Math.ceil(el.getBoundingClientRect().height));
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [port, requests]);
  const shown = requests.slice(0, POPUP_MAX);
  const rest = requests.length - shown.length;
  if (!shown.length) return null;
  return (
    <div ref={root} className={s.stack} role="dialog" aria-label={requests.some(isNeed) ? 'Waiting for you' : 'Requests from friends'}>
      <button type="button" className={s.close} aria-label="Hide (they still wait in Beluga)" title="Hide (they still wait in Beluga)" onClick={() => port.dismiss(requests.map((r) => r.approval))}>
        <Icon name="x" size={10} />
      </button>
      {shown.map((r) =>
        isNeed(r) ? (
          <NeedCard key={r.approval} r={r} open={() => port.act('review', r)} later={() => port.dismiss([r.approval])} />
        ) : (
          <Card key={r.approval} r={r} act={(action, req) => port.act(action, req)} />
        ),
      )}
      {rest > 0 ? (
        <button type="button" className={s.rest} onClick={() => port.act('review', { approval: '', task: '' })}>
          {rest} more waiting in Beluga
        </button>
      ) : null}
    </div>
  );
}
