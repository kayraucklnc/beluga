import type { Store } from './store.js';
import { StripeEarnings, attachEarnings } from './stripe-earnings.js';
import { DEMO_PAYMENT_EVERY, demoStripe } from './stripe-demo.js';
import { FxService } from './fx-rates.js';
import { belugaEnv } from './beluga-env.js';

/**
 * Start the earnings service for the daemon (the Mac app's Beluga): keys from ~/.beluga/stripe.json,
 * looked at in the background for new payments every few minutes. The demo uses a pretend Stripe
 * (where a payment arrives every few minutes, looked for every minute), keeps keys in memory only,
 * and connects bob-api so the earnings show. BELUGA_STRIPE_API points at another Stripe (a local
 * fake) for testing; BELUGA_DEMO_PAYMENT_EVERY (seconds) has the demo's payments arrive faster, to
 * watch what a new one does.
 */
export function launchEarnings(host: { readonly session: object; readonly store: Store; readonly demo: boolean }): () => void {
  const base = belugaEnv('STRIPE_API');
  const every = Number(belugaEnv('DEMO_PAYMENT_EVERY')) || DEMO_PAYMENT_EVERY;
  const service = host.demo
    ? new StripeEarnings({ store: host.store, file: null, stripe: { fetch: demoStripe(Date.now, every), sleep: async () => undefined }, watchMs: Math.min(60_000, (every * 1000) / 3) })
    : new StripeEarnings({ store: host.store, ...(base ? { stripe: { base } } : {}) });
  attachEarnings(host.session, service);
  service.start();
  // Exchange rates to add up several currencies (the demo uses made-up ones, no network).
  const fx = new FxService(host.demo ? { store: host.store, file: null, fetch: demoRates } : { store: host.store });
  fx.start();
  const off = host.demo ? connectDemo(host.store, service) : undefined;
  return () => {
    off?.();
    fx.stop();
    service.stop();
  };
}

/** The demo's bob-api has Stripe connected (once its projects are found). */
function connectDemo(store: Store, service: StripeEarnings): () => void {
  let done = false;
  const tryNow = (): void => {
    const project = store.getState().projects.find((p) => p.name === 'bob-api');
    if (done || !project) return;
    done = true;
    off();
    // A made-up demo key, built at runtime so secret scanners don't mistake it for a real one.
    void service.connect(project.id, ['rk', 'live', 'demoBobApi00000000000000'].join('_')).catch(() => undefined);
  };
  const off = store.subscribe(tryNow);
  tryNow();
  return off;
}

/** The demo's exchange rates: fixed, so nothing goes online. */
const demoRates: typeof fetch = async () => new Response(JSON.stringify({ base: 'USD', rates: { EUR: 0.92, GBP: 0.79, TRY: 34.1, INR: 83.9, JPY: 151.2, CAD: 1.37, AUD: 1.52, CHF: 0.88, CNY: 7.24 } }), { headers: { 'content-type': 'application/json' } });
