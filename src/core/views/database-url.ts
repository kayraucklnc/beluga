/**
 * Which Postgres a database view talks to, from your variables (Settings › Environment, the
 * project's .env): a connection string under a name people use for it, or one made from a
 * Supabase project's variables. The string goes only to psql on this Mac: problems say which
 * names to set, never a value.
 */

/** Names a connection string usually goes by, most likely first. */
export const DATABASE_URL_NAMES = [
  'DATABASE_URL',
  'POSTGRES_URL',
  'SUPABASE_DB_URL',
  'SUPABASE_DATABASE_URL',
  'DIRECT_URL',
  'POSTGRES_URL_NON_POOLING',
  'POSTGRES_PRISMA_URL',
  'PG_URL',
  'PGURL',
] as const;

const POSTGRES_URL = /^postgres(ql)?:\/\//i;
/** A Supabase project's address (https://<ref>.supabase.co), under any prefix (NEXT_PUBLIC_, VITE_, EXPO_PUBLIC_…). */
const SUPABASE_URL_KEY = /(^|_)SUPABASE_URL$/;
const SUPABASE_HOST = /^https?:\/\/([a-z0-9]{15,40})\.supabase\.(co|in)\/?$/i;
const SUPABASE_REF_KEYS = ['SUPABASE_PROJECT_REF', 'SUPABASE_PROJECT_ID', 'SUPABASE_REF'];
const SUPABASE_PASSWORD_KEYS = ['SUPABASE_DB_PASSWORD', 'SUPABASE_DATABASE_PASSWORD', 'SUPABASE_POSTGRES_PASSWORD', 'SUPABASE_PASSWORD', 'POSTGRES_PASSWORD', 'DB_PASSWORD', 'PGPASSWORD'];
/** The pooler's region (eu-central-1) or whole host (aws-0-eu-central-1.pooler.supabase.com). */
const SUPABASE_REGION_KEYS = ['SUPABASE_REGION', 'SUPABASE_DB_REGION'];
const SUPABASE_POOLER_KEYS = ['SUPABASE_POOLER_HOST', 'SUPABASE_DB_HOST'];

export type DatabaseUrl = { readonly url: string; readonly from: string } | { readonly problem: string };

const WHERE = 'Settings › Environment, or the project’s .env';

/** The connection string for a view: the variable it names, else the first one found, else Supabase's. */
export function databaseUrl(env: Readonly<Record<string, string | undefined>>, name?: string): DatabaseUrl {
  if (name) {
    const value = env[name]?.trim();
    if (!value) return { problem: `$${name} isn’t set (add it in ${WHERE})` };
    if (!POSTGRES_URL.test(value)) return { problem: `$${name} isn’t a Postgres connection string (postgres://…)` };
    return { url: value, from: `$${name}` };
  }
  for (const key of DATABASE_URL_NAMES) {
    const value = env[key]?.trim();
    if (value && POSTGRES_URL.test(value)) return { url: value, from: `$${key}` };
  }
  return supabaseUrl(env) ?? { problem: `No database found: set DATABASE_URL to its connection string (in ${WHERE})` };
}

/** A Supabase project's ref (from its address or a variable naming it), if the variables have one. */
export function supabaseRef(env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    const ref = SUPABASE_URL_KEY.test(key) ? SUPABASE_HOST.exec(value?.trim() ?? '')?.[1] : undefined;
    if (ref) return ref.toLowerCase();
  }
  const named = SUPABASE_REF_KEYS.map((k) => env[k]?.trim()).find((v) => v && /^[a-z0-9]{15,40}$/i.test(v));
  return named?.toLowerCase();
}

/**
 * Supabase's connection string, made from its parts: the session pooler when the region is known
 * (it works on every network), else the direct address. Without the database password it says
 * where to find it: the API keys in .env don't open the database.
 */
function supabaseUrl(env: Readonly<Record<string, string | undefined>>): DatabaseUrl | undefined {
  const ref = supabaseRef(env);
  if (!ref) return undefined;
  const passwordKey = SUPABASE_PASSWORD_KEYS.find((k) => env[k]);
  if (!passwordKey) {
    return {
      problem:
        `This project uses Supabase (${ref}), but its database password isn’t set. Add SUPABASE_DB_PASSWORD in ${WHERE} ` +
        '(Supabase › Project Settings › Database), or put the connection string from Supabase › Connect in DATABASE_URL.',
    };
  }
  const password = encodeURIComponent(env[passwordKey] ?? '');
  const pooler = SUPABASE_POOLER_KEYS.map((k) => env[k]?.trim()).find(Boolean);
  const region = SUPABASE_REGION_KEYS.map((k) => env[k]?.trim()).find((v) => v && /^[a-z]{2}-[a-z]+-\d$/.test(v));
  const host = pooler ?? (region ? `aws-0-${region}.pooler.supabase.com` : undefined);
  if (host) return { url: `postgresql://postgres.${ref}:${password}@${host}:5432/postgres`, from: `Supabase (${ref}) and $${passwordKey}` };
  return { url: `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`, from: `Supabase (${ref}) and $${passwordKey}` };
}

/** An error's text with the connection string (and its password) taken out. */
export function scrubbed(message: string, url: string): string {
  let out = message.split(url).join('postgres://…');
  const password = /^[^:]+:\/\/[^:@/]*:([^@]+)@/.exec(url)?.[1];
  if (password) for (const form of new Set([password, safeDecode(password)])) if (form.length >= 4) out = out.split(form).join('•••');
  return out;
}

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
