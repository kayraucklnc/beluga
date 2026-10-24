import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { BELUGA } from '../components/beluga-path.js';
import { Icon } from '../components/Icon.js';
import { cx } from '../components/ui.js';
import { type Grant, type PrivacyAccess, requestPrivacy } from '../lib/privacy.js';
import { ACCESS_COPY, accessAction, grantText } from './access-copy.js';
import { EASE_OUT, Rise, SPRING, Words } from './fx.js';
import { ACCESS, type AccessStep, type Step, accessPlace } from './onboarding-model.js';
import s from './onboarding.module.css';

/**
 * One macOS permission a step, every one optional: what it lets Claude do (one sentence), a
 * small System Settings pane showing whether Beluga has it (checked again as you come back), and
 * one button that opens the real pane there. Not Now (in the footer) passes on it.
 */

/** The app's icon, small: the beluga on its dark tile. */
export function AppTile({ size = 22 }: { readonly size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true" className={s.appTile}>
      <path d="M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z" fill="#1c1d21" />
      <g transform="translate(512 512) scale(0.76) translate(-512 -512)">
        <path d={BELUGA} fill="#F5F5F7" fillRule="evenodd" />
      </g>
    </svg>
  );
}

/** How it stands, as a soft pill: green once allowed, quiet otherwise. */
function GrantPill({ grant, asked }: { readonly grant: Grant | undefined; readonly asked: boolean }) {
  return (
    <motion.span key={`${grant}-${asked}`} className={s.grant} data-grant={grant ?? 'unknown'} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={SPRING}>
      <Icon name={grant === 'granted' ? 'check' : grant === 'off' ? 'lock' : 'info'} size={11} />
      {grantText(grant, asked)}
    </motion.span>
  );
}

/** System Settings › Privacy & Security › that pane, in miniature: Beluga in its list, its switch as macOS has it. */
function MiniPane({ step, grant }: { readonly step: AccessStep; readonly grant: Grant | undefined }) {
  const copy = ACCESS_COPY[step];
  const on = grant === 'granted';
  return (
    <div className={s.pane} aria-hidden="true">
      <div className={s.paneBar}>
        <span className={s.paneLights}>
          <i />
          <i />
          <i />
        </span>
        <Icon name="back" size={11} />
        <span>{copy.name}</span>
      </div>
      <div className={s.paneBody}>
        <span className={s.paneCrumb}>Privacy &amp; Security</span>
        <div className={s.paneList}>
          <div className={s.paneRow} data-faint>
            <span className={s.paneApp} style={{ background: '#d7dbe2' }} />
            <span className={s.paneName}>Terminal</span>
            <span className={s.paneSwitch} data-on />
          </div>
          <motion.div className={s.paneRow} data-ours animate={on ? { scale: [1, 1.02, 1] } : { scale: 1 }} transition={{ duration: 0.5, ease: EASE_OUT }}>
            <AppTile size={20} />
            <span className={s.paneName}>Beluga</span>
            <span className={s.paneSwitch} data-on={on || undefined}>
              <motion.i layout transition={SPRING} />
            </span>
          </motion.div>
          <div className={s.paneRow} data-faint>
            <span className={s.paneApp} style={{ background: '#e4dccf' }} />
            <span className={s.paneName}>Zoom</span>
            <span className={s.paneSwitch} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The four permissions as small chips under the step: where you are, which are allowed, each a way there. */
function AccessDots({ step, access, go }: { readonly step: AccessStep; readonly access: PrivacyAccess | undefined; readonly go: (to: Step) => void }) {
  return (
    <div className={s.accessDots} role="group" aria-label="Permissions">
      {ACCESS.map((a) => {
        const copy = ACCESS_COPY[a];
        const granted = access?.[a] === 'granted';
        return (
          <button key={a} type="button" className={cx(s.accessDot, a === step && s.accessDotOn)} data-tint={a} aria-current={a === step ? 'step' : undefined} aria-label={`${copy.name}${granted ? ', allowed' : ''}`} title={copy.name} onClick={() => go(a)}>
            <Icon name={copy.icon} size={12} />
            {/* Only the one you're on says its name: the others are a tap away. */}
            {a === step ? <span>{copy.name}</span> : null}
            {granted ? <Icon name="check" size={10} className={s.accessDotCheck} /> : null}
          </button>
        );
      })}
    </div>
  );
}

export function AccessStepView({ step, access, recheck, go }: { readonly step: AccessStep; readonly access: PrivacyAccess | undefined; readonly recheck: () => void; readonly go: (to: Step) => void }) {
  const copy = ACCESS_COPY[step];
  const grant = access?.[step];
  const [asked, setAsked] = useState(false);
  const [error, setError] = useState<string>();
  const place = accessPlace(step);
  const open = (): void => {
    setError(undefined);
    void requestPrivacy(copy.pane).then(
      () => {
        setAsked(true);
        recheck();
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  };
  return (
    <div className={s.tour}>
      <div className={s.tourText}>
        <Rise className={s.eyebrow}>
          <Icon name={copy.icon} size={12} /> {copy.name}
          {place ? <span className={s.eyebrowSoft}>· Optional · {place.at} of {place.of}</span> : null}
        </Rise>
        <h2 className={s.title}>
          <Words text={copy.title} delay={0.05} />
        </h2>
        <Rise delay={0.3} className={s.body}>
          {copy.why}
        </Rise>
        <Rise delay={0.4} className={s.accessStatus}>
          <AnimatePresence mode="wait" initial={false}>
            <GrantPill grant={grant} asked={asked} />
          </AnimatePresence>
          <span className={s.accessHint}>{grant === 'granted' ? 'You can change it any time in System Settings.' : asked ? copy.how : copy.without}</span>
        </Rise>
        <Rise delay={0.5} className={s.accessActions}>
          {grant === 'granted' ? (
            <button type="button" className={s.textLink} onClick={open}>
              <Icon name="external" size={11} /> Open System Settings
            </button>
          ) : (
            <motion.button type="button" className={s.solidButton} onClick={open} whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }} transition={{ type: 'spring', stiffness: 500, damping: 30 }}>
              <Icon name="external" size={13} />
              {accessAction(grant)}
            </motion.button>
          )}
        </Rise>
        {error ? <div className={s.accessError}>{error}</div> : null}
        <Rise delay={0.6}>
          <AccessDots step={step} access={access} go={go} />
        </Rise>
      </div>
      <motion.div className={cx(s.scene, s.paneScene)} initial={{ opacity: 0, scale: 0.94, filter: 'blur(12px)' }} animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }} transition={{ duration: 0.9, ease: EASE_OUT, delay: 0.1 }}>
        <div className={s.paneTile} data-tint={step}>
          <Icon name={copy.icon} size={26} />
        </div>
        <MiniPane step={step} grant={grant} />
      </motion.div>
    </div>
  );
}
