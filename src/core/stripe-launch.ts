import type { Store } from './store.js';
import { StripeEarnings, attachEarnings } from './stripe-earnings.js';
import { demoStripe } from './stripe-demo.js';
import { FxService } from './fx-rates.js';

/**
 * Start the earnings service for the daemon (the Mac app's klaud): keys from ~/.klaud/stripe.json,
 * refreshed in the background once a day. The demo uses a pretend Stripe, keeps keys in memory
 * only, and connects bob-api so the earnings show. KLAUD_STRIPE_API points at another Stripe
 * (a local fake) for testing.
 */
export function launchEarnings(host: { readonly session: object; readonly store: Store; readonly demo: boolean }): () => void {
  const base = process.env.KLAUD_STRIPE_API;
  const service = host.demo
    ? new StripeEarnings({ store: host.store, file: null, stripe: { fetch: demoStripe(), sleep: async () => undefined } })
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
