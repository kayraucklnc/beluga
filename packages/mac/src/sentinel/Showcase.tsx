import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon.js';
import { Button, cx } from '../components/ui.js';
import { NumberTile } from './NumberParts.js';
import type { NumberWords } from './numbers-model.js';
import s from './showcase.module.css';

/**
 * What Sentinel can do, shown before it's explained (BLG-334): a few scenes drawn with Beluga's
 * own parts and made-up numbers (a board filling in, a note on your phone, a failing test fixed, a
 * pull request read, a site that went down), one line each, and Set This Up, which hands its words
 * to Ask Sentinel. It moves on by itself every few seconds, holds while you point at it, and goes
 * by the dots or the arrow keys; with reduced motion it stays where you put it.
 */

type IconName = Parameters<typeof Icon>[0]['name'];

export interface Slide {
  readonly id: string;
  readonly icon: IconName;
  /** One line: what you get, never how. */
  readonly line: string;
  /** What Set This Up asks Ask Sentinel. */
  readonly prompt: string;
  readonly scene: () => React.ReactNode;
}

const word = (label: string, value: string, change: string, vs: string, trend: number[], tone: NumberWords['tone'] = 'good', unit?: string): NumberWords => ({ label, value, change, vs, trend, tone, ...(unit ? { unit } : {}) });

export const SLIDES: readonly Slide[] = [
  {
    id: 'board',
    icon: 'gauge',
    line: 'Your numbers on one board, fresh every morning',
    prompt: 'Look at my projects and put the numbers that matter on a board: sales, sign-ups, how fast the site answers, open pull requests. Set up what keeps them fresh every morning.',
    scene: () => (
      <div className={s.board}>
        <NumberTile className={s.boardTile} w={word('Revenue', '$3,412', '+$232 (+7.3%)', 'vs yesterday', [2.6, 2.9, 2.7, 3.0, 3.1, 2.9, 3.2, 3.4])} />
        <NumberTile className={s.boardTile} w={word('Sign-ups', '35', '+6 (+21%)', 'vs yesterday', [18, 22, 19, 25, 31, 24, 29, 35])} />
        <NumberTile className={s.boardTile} w={word('Site speed', '372', '−30 ms', 'vs last week', [420, 410, 610, 450, 400, 390, 380, 372], 'good', 'ms')} />
      </div>
    ),
  },
  {
    id: 'phone',
    icon: 'phone',
    line: 'A note on your phone with what needs you first',
    prompt: 'Every weekday morning, tell me on my phone what changed in my projects and what needs me first.',
    scene: () => (
      <div className={s.phone}>
        <div className={s.phoneTime}>7:00</div>
        <div className={s.phoneDate}>Tuesday, October 28</div>
        <div className={s.note}>
          <span className={s.noteIcon}>
            <Icon name="sentinel" size={13} />
          </span>
          <span className={s.noteText}>
            <strong>Morning brief</strong>
            <span>3 commits landed, 1 review waits on you, the tests pass</span>
          </span>
          <span className={s.noteWhen}>now</span>
        </div>
      </div>
    ),
  },
  {
    id: 'fix',
    icon: 'wrench',
    line: 'When the tests break, Claude fixes them and asks you to merge',
    prompt: 'When the tests fail on GitHub for one of my projects, have Claude find out why, fix it in a new worktree and open a pull request for me to merge.',
    scene: () => (
      <div className={s.flow}>
        <Stage icon="alert" tone="rose" title="Tests failed" sub="checkout · on GitHub" n={0} />
        <Icon name="arrowRight" size={14} className={s.flowArrow} />
        <Stage icon="claude" tone="peach" title="Claude found it" sub="a timeout, only on CI" n={1} />
        <Icon name="arrowRight" size={14} className={s.flowArrow} />
        <Stage icon="merge" tone="mint" title="Ready to merge" sub="pull request #52" n={2} />
      </div>
    ),
  },
  {
    id: 'review',
    icon: 'review',
    line: 'Every pull request read before you get to it',
    prompt: 'When a pull request opens in one of my projects, have Claude read the change and tell me what to look at, in a few lines.',
    scene: () => (
      <div className={s.review}>
        <div className={s.pr}>
          <Icon name="pr" size={14} />
          <span className={s.prTitle}>Retry refund webhooks</span>
          <span className={s.prNum}>#61</span>
        </div>
        <div className={s.bubble}>
          <span className={s.bubbleWho}>
            <Icon name="claude" size={12} />
            Claude
          </span>
          Looks good. One thing: a retried webhook can refund twice. Check line 48.
        </div>
      </div>
    ),
  },
  {
    id: 'uptime',
    icon: 'pulse',
    line: 'Know the minute your site stops answering',
    prompt: 'Check my website every 5 minutes and tell me on my phone the moment it stops answering, and when it’s back.',
    scene: () => (
      <div className={s.uptime}>
        <div className={s.bars} aria-hidden="true">
          {Array.from({ length: 36 }, (_, i) => (
            <i key={i} data-down={i === 27 || i === 28 ? '' : undefined} style={{ animationDelay: `${i * 18}ms` }} />
          ))}
        </div>
        <div className={s.uptimeLine}>
          <span className={s.down} />
          example.com stopped answering at 14:02 · back at 14:06
        </div>
      </div>
    ),
  },
];

function Stage({ icon, tone, title, sub, n }: { icon: IconName; tone: 'rose' | 'peach' | 'mint'; title: string; sub: string; n: number }) {
  return (
    <div className={s.stage} data-tone={tone} style={{ animationDelay: `${n * 420}ms` }}>
      <span className={s.stageIcon}>
        <Icon name={icon} size={14} />
      </span>
      <strong>{title}</strong>
      <span>{sub}</span>
    </div>
  );
}

const EVERY_MS = 5200;
const still = (): boolean => document.documentElement.dataset.motion === 'reduce' || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Showcase({ onPick }: { onPick: (slide: Slide) => void }) {
  const [at, setAt] = useState(0);
  const [held, setHeld] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const go = (i: number): void => setAt((i + SLIDES.length) % SLIDES.length);
  useEffect(() => {
    if (held || still()) return;
    const t = setTimeout(() => go(at + 1), EVERY_MS);
    return () => clearTimeout(t);
  }, [at, held]);
  const slide = SLIDES[at]!;
  return (
    <div
      ref={root}
      className={s.show}
      role="region"
      aria-roledescription="carousel"
      aria-label="What Sentinel can do"
      tabIndex={0}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !root.current?.contains(e.relatedTarget as Node | null) && setHeld(false)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') go(at + 1);
        else if (e.key === 'ArrowLeft') go(at - 1);
        else return;
        e.preventDefault();
      }}
    >
      <div className={s.screen} data-slide={slide.id}>
        {/* Keyed: each scene plays from its start when it comes in. */}
        <div key={slide.id} className={s.scene} role="group" aria-roledescription="slide" aria-label={`${at + 1} of ${SLIDES.length}: ${slide.line}`}>
          {slide.scene()}
        </div>
      </div>
      <div className={s.foot}>
        <span key={slide.id} className={s.line}>
          <Icon name={slide.icon} size={14} />
          {slide.line}
        </span>
        <Button size="small" variant="primary" onClick={() => onPick(slide)}>
          Set This Up
        </Button>
      </div>
      <div className={s.dots} role="tablist" aria-label="Scenes">
        {SLIDES.map((x, i) => (
          <button key={x.id} type="button" role="tab" aria-selected={i === at} aria-label={x.line} className={cx(s.dot, i === at && s.dotOn)} data-held={held || undefined} onClick={() => go(i)}>
            <span style={i === at ? { animationDuration: `${EVERY_MS}ms` } : undefined} />
          </button>
        ))}
      </div>
    </div>
  );
}
