/**
 * What a Stripe key looks like, checked before anything is sent anywhere (the core when you
 * connect, the Mac app's sheet as you type). Browser-safe.
 */

/** A restricted (rk_) or secret (sk_) key, live or test. */
export const STRIPE_KEY = /^(rk|sk)_(live|test)_[A-Za-z0-9]{16,}$/;

/** What's wrong with a pasted key, if anything. */
export function stripeKeyProblem(key: string): string | undefined {
  if (!key) return 'Paste a key from your Stripe dashboard';
  if (/^pk_/.test(key)) return 'That’s a publishable key (pk_…). klaud needs a restricted key (rk_…) that can read charges.';
  if (/^whsec_/.test(key)) return 'That’s a webhook signing secret. klaud needs a restricted key (rk_…) that can read charges.';
  if (!STRIPE_KEY.test(key)) return 'That doesn’t look like a Stripe key. Restricted keys start with rk_live_ or rk_test_.';
  return undefined;
}

/** Live or test, and whether it's a full secret key (it works, but could do far more than read). */
export function stripeKeyKind(key: string): { readonly mode?: 'live' | 'test'; readonly secret: boolean } {
  const m = /^(rk|sk)_(live|test)_/.exec(key.trim());
  return { ...(m ? { mode: m[2] as 'live' | 'test' } : {}), secret: key.trim().startsWith('sk_') };
}
