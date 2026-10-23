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
/** The pooler's region (eu-central-1) or whole host (aws-1-eu-central-1.pooler.supabase.com). */
const SUPABASE_REGION_KEYS = ['SUPABASE_REGION', 'SUPABASE_DB_REGION'];
const SUPABASE_POOLER_KEYS = ['SUPABASE_POOLER_HOST', 'SUPABASE_DB_HOST'];
/** Supabase's direct address: IPv6 only, so on most networks it never answers. */
const SUPABASE_DIRECT = /@db\.([a-z0-9]{15,40})\.supabase\.(co|in)(:\d+)?\//i;
/** What Supabase › Connect shows in place of the password. */
const PASSWORD_PLACEHOLDER = /\[YOUR[-_ ]PASSWORD\]/i;

export type DatabaseUrl =
  | {
      /** The connection string, and others to try in turn if it can't be reached (Supabase's poolers). */
      readonly url: string;
      readonly more?: readonly string[];
      readonly from: string;
      /** Said when none can be reached. */
      readonly hint?: string;
    }
  | { readonly problem: string };

const WHERE = 'Settings › Environment, or the project’s .env';
const REGION_HINT =
  'Supabase’s direct address only works over IPv6. Set SUPABASE_REGION (Supabase › Connect › Session pooler shows it, e.g. eu-central-1), or put the Session pooler connection string in DATABASE_URL.';

type Env = Readonly<Record<string, string | undefined>>;

/** The connection string for a view: the variable it names, else the first one found, else Supabase's. */
export function databaseUrl(env: Env, name?: string): DatabaseUrl {
  if (name) {
    const value = env[name]?.trim();
    if (!value) return { problem: `$${name} isn’t set (add it in ${WHERE})` };
    if (!POSTGRES_URL.test(value)) return { problem: `$${name} isn’t a Postgres connection string (postgres://…)` };
    return withPoolers(value, `$${name}`, env);
  }
  for (const key of DATABASE_URL_NAMES) {
    const value = env[key]?.trim();
    if (value && POSTGRES_URL.test(value)) return withPoolers(value, `$${key}`, env);
  }
  return supabaseUrl(env) ?? { problem: `No database found: set DATABASE_URL to its connection string (in ${WHERE})` };
}

/** A connection string as given; Supabase's direct one also gets its poolers to fall back on. */
function withPoolers(url: string, from: string, env: Env): DatabaseUrl {
  if (PASSWORD_PLACEHOLDER.test(url)) return { problem: `${from} still has [YOUR-PASSWORD] in it: put the database password there (Supabase › Project Settings › Database)` };
  const direct = SUPABASE_DIRECT.exec(url);
  if (!direct) return { url, from };
  const ref = direct[1]!.toLowerCase();
  const password = /^[^:]+:\/\/[^:@/]*:([^@]+)@/.exec(url)?.[1];
  const database = /\/([^/?]+)(\?.*)?$/.exec(url)?.[1] ?? 'postgres';
  const more = password ? poolers(ref, password, env, database) : [];
  return { url, from, ...(more.length ? { more } : {}), hint: more.length ? undefined : REGION_HINT };
}

/** A Supabase project's ref (from its address or a variable naming it), if the variables have one. */
export function supabaseRef(env: Env): string | undefined {
  for (const [key, value] of Object.entries(env)) {
    const ref = SUPABASE_URL_KEY.test(key) ? SUPABASE_HOST.exec(value?.trim() ?? '')?.[1] : undefined;
    if (ref) return ref.toLowerCase();
  }
  const named = SUPABASE_REF_KEYS.map((k) => env[k]?.trim()).find((v) => v && /^[a-z0-9]{15,40}$/i.test(v));
  return named?.toLowerCase();
}

/**
 * The session poolers for a Supabase project: the host you named, else both families of its
 * region's (projects live on aws-0 or aws-1, and only one knows yours). `password` is encoded.
 */
function poolers(ref: string, password: string, env: Env, database = 'postgres'): string[] {
  const named = SUPABASE_POOLER_KEYS.map((k) => env[k]?.trim()).find(Boolean);
  const region = SUPABASE_REGION_KEYS.map((k) => env[k]?.trim()).find((v) => v && /^[a-z]{2}-[a-z]+-\d$/.test(v));
  const hosts = named ? [named] : region ? [`aws-0-${region}.pooler.supabase.com`, `aws-1-${region}.pooler.supabase.com`] : [];
  return hosts.map((host) => `postgresql://postgres.${ref}:${password}@${host}:5432/${database}`);
}

/**
 * Supabase's connection string, made from its parts: its session poolers when the region is
 * known (they work on every network), else the direct address. Without the database password
 * it says where to find it: the API keys in .env don't open the database.
 */
function supabaseUrl(env: Env): DatabaseUrl | undefined {
  const ref = supabaseRef(env);
  if (!ref) return undefined;
  const passwordKey = SUPABASE_PASSWORD_KEYS.find((k) => env[k]);
  if (!passwordKey) {
    return {
      problem:
        `This project uses Supabase (${ref}), but its database password isn’t set. Add SUPABASE_DB_PASSWORD in ${WHERE} ` +
        '(Supabase › Project Settings › Database), or put the Session pooler connection string from Supabase › Connect in DATABASE_URL',
    };
  }
  const password = encodeURIComponent(env[passwordKey] ?? '');
  const from = `Supabase (${ref}) and $${passwordKey}`;
  const [first, ...more] = poolers(ref, password, env);
  if (first) return { url: first, from, ...(more.length ? { more } : {}) };
  return { url: `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`, from, hint: REGION_HINT };
}

/** psql couldn't reach the server at all (worth trying the next address), rather than an answer like a wrong password or bad SQL. */
export function unreachable(message: string): boolean {
  return /timeout expired|timed out|could not translate host|Network is unreachable|No route to host|Connection refused|tenant(\/user)? .*not found|Tenant or user not found|could not connect to server|connection to server .* failed: (?!FATAL)/i.test(message) && !/password authentication failed/i.test(message);
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
