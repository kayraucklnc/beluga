import { motion, useReducedMotion } from 'motion/react';
import { ORCA } from '../components/orca-path.js';

/**
 * The orca (assets/logo.svg), drawn in: the tile rises out of the dark, the orca leaps up into
 * it and settles, then a sheen crosses the tile and its glow comes up, as if the app just
 * became ready for you.
 */

const TILE = 'M512 62C890 62 962 134 962 512S890 962 512 962 62 890 62 512 134 62 512 62Z';
const EASE = [0.22, 1, 0.36, 1] as const;

export function Mark({ size = 132, delay = 0 }: { readonly size?: number; readonly delay?: number }) {
  const still = useReducedMotion() ?? false;
  const at = (s: number): number => (still ? 0 : delay + s);
  const leap = (stiffness: number, damping: number) => ({ type: 'spring' as const, stiffness, damping, delay: at(0.45) });
  return (
    <motion.svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="Orca"
      initial={still ? false : { opacity: 0, scale: 0.86, y: 14, filter: 'blur(10px)' }}
      animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
      transition={{ duration: 1.1, ease: EASE, delay: at(0) }}
      style={{ overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="mark-bg" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#ECEDF0" />
        </linearGradient>
        <linearGradient id="mark-sheen" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#fff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id="mark-clip">
          <path d={TILE} />
        </clipPath>
        <filter id="mark-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="40" />
        </filter>
      </defs>
      {/* The tile's glow: comes up once the orca has landed, and stays soft. */}
      <motion.path
        d={TILE}
        fill="#fff"
        filter="url(#mark-glow)"
        initial={still ? false : { opacity: 0 }}
        animate={still ? { opacity: 0.16 } : { opacity: [0, 0.3, 0.16] }}
        transition={{ duration: 1.6, delay: at(1.15), ease: 'easeOut' }}
      />
      <path d={TILE} fill="url(#mark-bg)" />
      <path d={TILE} fill="none" stroke="#000" strokeOpacity="0.06" strokeWidth="4" />
      {/* The orca leaps up from the tile's lower edge (clipped, as if out of the water). */}
      <g clipPath="url(#mark-clip)">
        <g transform="translate(512 512) scale(0.76) translate(-512 -512)">
          <motion.path
            d={ORCA}
            fill="#0B0B0C"
            fillRule="evenodd"
            style={{ originX: 0.5, originY: 0.5 }}
            initial={still ? false : { opacity: 0, x: -150, y: 210, rotate: -16 }}
            animate={{ opacity: 1, x: 0, y: 0, rotate: 0 }}
            transition={still ? { duration: 0 } : { x: leap(120, 17), y: leap(120, 15), rotate: leap(110, 13), opacity: { duration: 0.2, delay: at(0.45) } }}
          />
        </g>
        {/* One sheen across the tile, like light off the water. */}
        {!still && (
          <g transform="rotate(18 512 512)">
            <motion.rect
              x="-260"
              y="-200"
              width="240"
              height="1424"
              fill="url(#mark-sheen)"
              initial={{ x: 0, opacity: 0 }}
              animate={{ x: 1500, opacity: [0, 0.7, 0.7, 0] }}
              transition={{ duration: 1.3, delay: at(1.15), ease: [0.45, 0, 0.25, 1] }}
            />
          </g>
        )}
      </g>
    </motion.svg>
  );
}
