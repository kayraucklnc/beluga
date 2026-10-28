/**
 * A Supabase Storage object's link, signed when it's clicked (BLG-345): the project's own Supabase
 * variables (its URL under any prefix, and a service key) sign one object for about a minute. The
 * key goes only to Supabase from this Mac; the link is handed to the screen that asked and never
 * kept. Problems say which names to set, never a value.
 */

type Env = Readonly<Record<string, string | undefined>>;

const WHERE = 'Settings › Environment, or the project’s .env';
/** A Supabase project's address, under any prefix (NEXT_PUBLIC_, VITE_, EXPO_PUBLIC_…). */
const URL_KEY = /(^|_)SUPABASE_URL$/;
const SUPABASE_HOST = /^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i;
/** A key that can sign any object: the service role's, or the newer secret key. Never a public one. */
const KEY_NAMES = ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_KEY', 'SUPABASE_SECRET_KEY', 'SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE'];
const PUBLIC = /^(NEXT_PUBLIC|VITE|EXPO_PUBLIC|PUBLIC|REACT_APP|NUXT_PUBLIC)_/;

/** The project's Supabase address and signing key, or which names are missing. */
export function supabaseStorageEnv(env: Env): { readonly url: string; readonly key: string; readonly keyFrom: string } | { readonly problem: string } {
  const urls = Object.entries(env).filter(([k, v]) => URL_KEY.test(k) && v?.trim());
  // A custom domain is fine too; a supabase.co address is preferred when there are several.
  const url = (urls.find(([, v]) => SUPABASE_HOST.test(v!.trim())) ?? urls[0])?.[1]?.trim().replace(/\/+$/, '');
  const keyEntry = KEY_NAMES.map((n) => [n, env[n]] as const).find(([, v]) => v?.trim()) ?? Object.entries(env).find(([k, v]) => !PUBLIC.test(k) && /SUPABASE.*(SERVICE_ROLE|SECRET)_KEY$/.test(k) && v?.trim());
  if (!url && !keyEntry) return { problem: `Signing a storage link needs the project’s Supabase address and service key: set \`$SUPABASE_URL\` and \`$SUPABASE_SERVICE_ROLE_KEY\` in ${WHERE}` };
  if (!url) return { problem: `Signing a storage link needs the project’s Supabase address: set \`$SUPABASE_URL\` in ${WHERE}` };
  if (!keyEntry) return { problem: `Signing a storage link needs a key that can read the bucket: set \`$SUPABASE_SERVICE_ROLE_KEY\` in ${WHERE}` };
  if (!/^https?:\/\//i.test(url)) return { problem: 'The project’s `$SUPABASE_URL` isn’t an address (https://<ref>.supabase.co)' };
  return { url, key: keyEntry[1]!.trim(), keyFrom: keyEntry[0] };
}

/** An object's path as Storage's URL takes it: each part encoded, the slashes kept. */
const encodePath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** A link to one object, signed for `seconds` → the whole URL; throws in words. */
export async function signStorageUrl(env: Env, bucket: string, objectPath: string, seconds: number, fetchFn: typeof fetch): Promise<string> {
  const found = supabaseStorageEnv(env);
  if ('problem' in found) throw new Error(found.problem);
  const at = `${found.url}/storage/v1/object/sign/${encodeURIComponent(bucket)}/${encodePath(objectPath)}`;
  let res: Response;
  try {
    res = await fetchFn(at, {
      method: 'POST',
      headers: { Authorization: `Bearer ${found.key}`, apikey: found.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: seconds }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Supabase didn’t answer: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    let said = '';
    try {
      const j = JSON.parse(text) as { message?: unknown; error?: unknown };
      said = String(j.message ?? j.error ?? '');
    } catch {
      said = text.slice(0, 200);
    }
    if (res.status === 404 || /not.?found/i.test(said)) throw new Error(`${bucket}/${objectPath} isn’t in Storage (or the bucket doesn’t exist)`);
    if (res.status === 401 || res.status === 403) throw new Error(`Supabase refused \`$${found.keyFrom}\`: it needs the service role key`);
    throw new Error(`Supabase said ${res.status}${said ? `: ${said.replace(found.key, '…')}` : ''}`);
  }
  let signed: unknown;
  try {
    const j = JSON.parse(text) as { signedURL?: unknown; signedUrl?: unknown };
    signed = j.signedURL ?? j.signedUrl;
  } catch {
    signed = undefined;
  }
  if (typeof signed !== 'string' || !signed) throw new Error('Supabase answered without a link');
  // It answers a path under /storage/v1 ("/object/sign/…?token=…"), or (newer) the whole link.
  return /^https?:\/\//i.test(signed) ? signed : `${found.url}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
}
