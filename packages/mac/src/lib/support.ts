import { useSyncExternalStore } from 'react';
import type { SupportAsk } from '@beluga/core/support-store.js';

/**
 * Supporting Beluga: where the star and the coffee go, and the sheets opened by hand (Settings ›
 * About, the palette). The asks that come with merges are the daemon's (the shared state's
 * `support`, core/support-store.ts); these are the same sheets, any time, asking nothing back.
 */

export const GITHUB_URL = 'https://github.com/kayraucklnc/beluga';

/** The coffee amounts offered, in US dollars. */
export const COFFEE_AMOUNTS = [5, 10, 20, 50] as const;
export type CoffeeAmount = (typeof COFFEE_AMOUNTS)[number];

/**
 * Stripe Payment Links, one per amount and one where you choose the amount (Stripe's "customers
 * choose what to pay"). These are public checkout pages anyone may open: no keys, nothing secret,
 * safe in a public repo. Make them in the Stripe Dashboard › Payment Links and paste them here;
 * until then the placeholders open as they are.
 */
export const COFFEE_LINKS: Readonly<Record<CoffeeAmount | 'other', string>> = {
  5: 'https://buy.stripe.com/REPLACE_5',
  10: 'https://buy.stripe.com/REPLACE_10',
  20: 'https://buy.stripe.com/REPLACE_20',
  50: 'https://buy.stripe.com/REPLACE_50',
  other: 'https://buy.stripe.com/REPLACE_CUSTOM',
};

// ---- a sheet opened by hand (one at a time)

let opened: SupportAsk | undefined;
const listeners = new Set<() => void>();
const emit = (): void => {
  for (const l of [...listeners]) l();
};

export function openSupport(ask: SupportAsk): void {
  opened = ask;
  emit();
}

export function closeSupport(): void {
  if (!opened) return;
  opened = undefined;
  emit();
}

/** The sheet you opened yourself, if any. */
export const useOpenedSupport = (): SupportAsk | undefined =>
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => opened,
  );
