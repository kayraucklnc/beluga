import { motion, useReducedMotion } from 'motion/react';

/**
 * Klaud's >_ mark (assets/logo.svg), drawn in: the tile rises out of the dark, the prompt is
 * written stroke by stroke, then the copper cursor slides out and starts to blink, as if the
 * app just became ready for you.
 */

const TILE = 'M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z';
const EASE = [0.22, 1, 0.36, 1] as const;

export function Mark({ size = 132, delay = 0 }: { readonly size?: number; readonly delay?: number }) {
  const still = useReducedMotion() ?? false;
  const at = (s: number): number => (still ? 0 : delay + s);
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Klaud"
      initial={still ? false : { opacity: 0, scale: 0.86, y: 14, filter: 'blur(10px)' }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 1.1, ease: EASE, delay: at(0) }}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="mark-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2A2C31" />
          <stop offset="1" stopColor="#0F1013" />
        </linearGradient>
        <linearGradient id="mark-rim" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.2" />
          <stop offset="0.4" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="mark-cursor" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E58C6C" />
          <stop offset="1" stopColor="#CF6A48" />
        </linearGradient>
        <filter id="mark-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="26" />
        </filter>
      </defs>
      <path d={TILE} fill="url(#mark-bg)" />
      <path d={TILE} fill="none" stroke="url(#mark-rim)" strokeWidth="5" />
      <motion.path
        d="M318 386 L452 512 L318 638"
        fill="none"
        stroke="#F2F2F4"
        strokeWidth="54"
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={still ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ pathLength: { duration: 0.75, ease: [0.65, 0, 0.35, 1], delay: at(0.45) }, opacity: { duration: 0.01, delay: at(0.45) } }}
      />
      {/* The cursor's glow, then the cursor: out from the prompt, then blinking. */}
      <motion.rect
        x="512"
        y="586"
        width="196"
        height="54"
        rx="27"
        fill="#E07A55"
        filter="url(#mark-glow)"
        initial={still ? false : { opacity: 0 }}
        animate={still ? { opacity: 0.35 } : { opacity: [0, 0.55, 0.3] }}
        transition={{ duration: 1.4, delay: at(1.15), ease: 'easeOut' }}
      />
      <motion.rect
        x="512"
        y="586"
        width="196"
        height="54"
        rx="27"
        fill="url(#mark-cursor)"
        style={{ originX: 0, originY: 0.5 }}
        initial={still ? false : { scaleX: 0, opacity: 0 }}
        animate={still ? { scaleX: 1, opacity: 1 } : { scaleX: 1, opacity: [0, 1, 1, 0.15, 1] }}
        transition={
          still
            ? { duration: 0 }
            : {
                scaleX: { type: 'spring', stiffness: 260, damping: 22, delay: at(1.15) },
                opacity: { duration: 2.4, times: [0, 0.08, 0.55, 0.75, 1], delay: at(1.15), repeat: Infinity, repeatDelay: 0.6, ease: 'linear' },
              }
        }
      />
    </motion.svg>
  );
}
