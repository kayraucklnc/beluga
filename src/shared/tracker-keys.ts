/**
 * What a tracker's key looks like (Linear's personal API keys), checked before anything is sent
 * anywhere: the core when you connect, the Mac app's sheet as you type. Browser-safe.
 */

/** A Linear personal API key. */
export const LINEAR_KEY = /^lin_api_[A-Za-z0-9]{20,80}$/;

/** Where to make one. */
export const LINEAR_KEY_URL = 'https://linear.app/settings/account/security';

/** What's wrong with a pasted Linear key, if anything. */
export function linearKeyProblem(key: string): string | undefined {
  if (!key) return 'Paste a Linear API key';
  if (/^lin_oauth_/.test(key)) return 'That’s an OAuth token: make a personal API key instead';
  if (!key.startsWith('lin_api_')) return 'A Linear API key starts with lin_api_';
  if (!LINEAR_KEY.test(key)) return 'That doesn’t look like a whole key: copy it again';
  return undefined;
}
