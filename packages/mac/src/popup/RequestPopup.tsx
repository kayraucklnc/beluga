import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Avatar, Button } from '../components/ui.js';
import type { PopupPort } from '../gateway/popup-bridge.js';
import { POPUP_MAX, type PopupRequest, popupButtons, popupWho } from '../gateway/popup-model.js';
import type { RequestAction } from '../gateway/request-actions.js';
import s from './popup.module.css';

/**
 * A friend's request, on top of whatever you're doing: who, a few words of what they want,
 * and Allow / Allow Always / Decline. See more shows everything their Claude sent (the full
 * ask, what it needs, where it runs, what goes back) before you answer.
 */

const KIND_ICON = { ask: 'claude', run: 'terminal', file: 'file' } as const;

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
    <article className={s.card} data-testid="request-popup-card" aria-label={`${popupWho(r)} wants to ${r.gist}`}>
      <header className={s.head}>
        <Avatar name={r.peerName} id={r.peerId} claude={r.claude} size={30} />
        <div className={s.headText}>
          <div className={s.who}>
            <strong>{popupWho(r)}</strong> wants to
          </div>
          <div className={s.gist}>
            <Icon name={KIND_ICON[r.kind]} size={13} />
            <span>{r.gist}</span>
          </div>
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
          <div className={s.label}>{r.kind === 'ask' ? `What ${popupWho(r)} sends your Claude` : r.kind === 'run' ? 'The command' : 'The file'}</div>
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
  const [requests, setRequests] = useState<readonly PopupRequest[]>([]);
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
    <div ref={root} className={s.stack} role="dialog" aria-label="Requests from friends">
      <button type="button" className={s.close} aria-label="Hide (they still wait in Beluga)" title="Hide (they still wait in Beluga)" onClick={() => port.dismiss(requests.map((r) => r.approval))}>
        <Icon name="x" size={10} />
      </button>
      {shown.map((r) => (
        <Card key={r.approval} r={r} act={(action, req) => port.act(action, req)} />
      ))}
      {rest > 0 ? (
        <button type="button" className={s.rest} onClick={() => port.act('review', { approval: '', task: '' })}>
          {rest} more waiting in Beluga
        </button>
      ) : null}
    </div>
  );
}
