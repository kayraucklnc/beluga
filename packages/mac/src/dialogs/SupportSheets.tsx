import { useEffect, useRef, useState } from 'react';
import type { SupportAnswer, SupportAsk } from '@beluga/core/support-store.js';
import { Confetti } from '../components/Confetti.js';
import { FormSheet, formStyles as f } from '../components/FormSheet.js';
import { Icon } from '../components/Icon.js';
import { useApi, useApp } from '../lib/beluga.js';
import { COFFEE_AMOUNTS, COFFEE_LINKS, GITHUB_URL, closeSupport, useOpenedSupport } from '../lib/support.js';
import { openExternal } from '../lib/system.js';
import { useClock, windowActive } from '../lib/window-active.js';
import s from './support.module.css';

/**
 * The two asks merged work brings (core/support-store.ts): a star on GitHub after the first merge,
 * with confetti, and a coffee after the fifth. They wait for a calm moment (no other sheet up, the
 * window in front), so they never land on top of what you're doing. Opened by hand (Settings ›
 * About, the palette) they're the same sheets, and answering them tells the daemon nothing.
 */
export function SupportSheets() {
  const api = useApi();
  const support = useApp((st) => st.support);
  const opened = useOpenedSupport();
  const calm = useCalmMoment(Boolean(support.due) && !opened);
  const ask: SupportAsk | undefined = opened ?? (calm ? support.due : undefined);
  if (!ask) return null;
  const byHand = opened !== undefined;
  const answer = (a: SupportAnswer): void => {
    if (byHand) closeSupport();
    else void api.support.answer(ask, a);
  };
  return ask === 'star' ? <StarSheet onAnswer={answer} /> : <CoffeeSheet merges={support.merges} byHand={byHand} onAnswer={answer} />;
}

/** True once nothing else has been up for a couple of seconds (latched: the ask's own sheet doesn't undo it). */
function useCalmMoment(waiting: boolean): boolean {
  const [calm, setCalm] = useState(false);
  const quiet = useRef(0);
  // Ticks only while you're looking at the window (lib/window-active.ts).
  const now = useClock(waiting && !calm, 900);
  useEffect(() => {
    if (!waiting) {
      quiet.current = 0;
      return setCalm(false);
    }
    if (calm) return;
    const busy = !windowActive() || document.querySelector('[role="dialog"], [role="alertdialog"]');
    quiet.current = busy ? 0 : quiet.current + 1;
    if (quiet.current > 2) setCalm(true);
  }, [now, waiting, calm]);
  return waiting && calm;
}

function StarSheet({ onAnswer }: { onAnswer: (a: SupportAnswer) => void }) {
  return (
    <>
      <Confetti />
      <FormSheet
        title="Your first merge with Beluga"
        icon="star"
        intro={<p>Work you made in Beluga just landed. Congratulations!</p>}
        submitLabel="Star on GitHub"
        cancelLabel="Maybe Later"
        width={460}
        onSubmit={() => {
          void openExternal(GITHUB_URL);
          onAnswer('yes');
        }}
        onCancel={() => onAnswer('later')}
      >
        <div className={s.note} data-support="star">
          <Icon name="heart" size={14} className={s.noteIcon} />
          <p>
            Beluga is free software, and a passion project. Stars are how other people find it, and each one truly matters to Kayra. If Beluga has helped you, a star on GitHub would mean a lot.
          </p>
        </div>
      </FormSheet>
    </>
  );
}

function CoffeeSheet({ merges, byHand, onAnswer }: { merges: number; byHand: boolean; onAnswer: (a: SupportAnswer) => void }) {
  const give = (link: string): void => {
    void openExternal(link);
    onAnswer('yes');
  };
  return (
    <FormSheet
      title="Buy Kayra a coffee"
      icon="cup"
      intro={<p>{byHand || merges < 2 ? 'Beluga is a passion project.' : `You’ve merged work made in Beluga ${merges} times. Beluga is a passion project.`}</p>}
      submitLabel="Done"
      hideSubmit
      cancelLabel={byHand ? 'Close' : 'Not Now'}
      width={480}
      onSubmit={() => undefined}
      onCancel={() => onAnswer('later')}
      footer={
        byHand ? undefined : (
          <button type="button" className={f.linkButton} onClick={() => onAnswer('never')}>
            Don’t Ask Again
          </button>
        )
      }
    >
      <div className={s.note} data-support="coffee">
        <Icon name="heart" size={14} className={s.noteIcon} />
        <p>It’s free and will always stay free. Kayra builds and maintains it, and a coffee now and then keeps it going.</p>
      </div>
      <div className={s.amounts} role="group" aria-label="Amount">
        {COFFEE_AMOUNTS.map((amount) => (
          <button key={amount} type="button" className={s.amount} onClick={() => give(COFFEE_LINKS[amount])}>
            ${amount}
          </button>
        ))}
        <button type="button" className={s.other} onClick={() => give(COFFEE_LINKS.other)}>
          Other amount
        </button>
      </div>
      <div className={s.fine}>Opens a Stripe checkout in your browser. Amounts in US dollars.</div>
    </FormSheet>
  );
}
