/**
 * Which Postgres a database view talks to, from your variables (Settings › Environment, the
 * project's .env): a connection string under a name people use for it, or one made from a
 * Supabase project's variables. The string goes only to psql on this Mac: problems say which
 * names to set, never a value.
 *
 * Supabase (BLG-302): its direct address (db.<ref>.supabase.co) answers only over IPv6, so on most
 * networks it never does. Its session poolers (aws-0-<region> or aws-1-<region>.pooler.supabase.com,
 * user postgres.<ref>) work everywhere; the pure parts of finding the right one are here, the
 * dialing is postgres-connect.ts.
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
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const DIRECT_HOST = /^db\.([a-z0-9]{15,40})\.supabase\.(co|in)$/i;
const POOLER_HOST = /^(aws-\d+-([a-z]{2}-[a-z]+-\d))\.pooler\.supabase\.com$/i;
/** A pooler's host anywhere in a value (another variable holding the pooler's string tells the region). */
const POOLER_IN_TEXT = /\b(aws-\d+-[a-z]{2}-[a-z]+-\d\.pooler\.supabase\.com)\b/i;
/** What Supabase › Connect shows in place of the password. */
const PASSWORD_PLACEHOLDER = /\[YOUR[-_ ]PASSWORD\]/i;
/** A value that is only a host name (db.x.supabase.co, localhost:5432), not a connection string. */
const HOST_ONLY = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d+)?$/i;

/**
 * Supabase's regions with a session pooler, the busiest first: when the region isn't known, each
 * is asked in turn (aws-0 and aws-1) until one knows the project.
 */
export const SUPABASE_REGIONS = [
  'us-east-1',
  'eu-central-1',
  'us-west-1',
  'eu-west-1',
  'ap-southeast-1',
  'eu-west-2',
  'us-east-2',
  'ap-south-1',
  'ap-northeast-1',
  'ap-southeast-2',
  'sa-east-1',
  'ca-central-1',
  'eu-west-3',
  'eu-north-1',
  'eu-central-2',
  'ap-northeast-2',
  'us-west-2',
] as const;

/** What the connector knows about a Supabase database, to find its session pooler. */
export interface SupabaseInfo {
  readonly ref: string;
  /** From SUPABASE_REGION, or a pooler host another variable names. */
  readonly region?: string;
  /** The pooler host you named (SUPABASE_POOLER_HOST) or another variable holds. */
  readonly host?: string;
}

/** Another password to try when the one in the connection string is rejected (SUPABASE_DB_PASSWORD…): URL-encoded. */
export interface OtherPassword {
  readonly from: string;
  readonly value: string;
}

export type DatabaseUrl =
  | {
      /** The connection string, and others to try in turn if it can't be reached (Supabase's poolers). */
      readonly url: string;
      readonly more?: readonly string[];
      readonly from: string;
      /** Said when none can be reached. */
      readonly hint?: string;
      /** A Supabase database: its session pooler is looked for when its address can't be reached. */
      readonly supabase?: SupabaseInfo;
      /** Tried in turn when the connection string's password is rejected. */
      readonly passwords?: readonly OtherPassword[];
    }
  | { readonly problem: string };

export type FoundDatabase = Extract<DatabaseUrl, { url: string }>;

const WHERE = 'Settings › Environment, or the project’s .env';

/**
 * A variable's name as error text shows it: as inline code, so a screen that draws Markdown keeps its
 * underscores (`$DATABASE_POOLER_URL`, never $DATABASEPOOLERURL).
 */
export const varName = (name: string): string => `\`$${name}\``;

type Env = Readonly<Record<string, string | undefined>>;

/** The connection string for a view: the variable it names, else the first one found, else Supabase's. */
export function databaseUrl(env: Env, name?: string): DatabaseUrl {
  if (name) {
    const value = env[name]?.trim();
    if (!value) return { problem: `${varName(name)} isn’t set (add it in ${WHERE})` };
    if (!POSTGRES_URL.test(value)) return { problem: notAUrl(name, value) };
    return databaseUrlOf(value, varName(name), env);
  }
  let wrong: string | undefined;
  for (const key of DATABASE_URL_NAMES) {
    const value = env[key]?.trim();
    if (value && POSTGRES_URL.test(value)) return databaseUrlOf(value, varName(key), env);
    if (value) wrong ??= key;
  }
  // A connection string's name holding something else is said, never passed over for another database.
  if (wrong) return { problem: notAUrl(wrong, env[wrong]!.trim()) };
  return supabaseUrl(env) ?? { problem: `No database found: set DATABASE_URL to its connection string (in ${WHERE})` };
}

/** Why a variable isn't a connection string, without its value. */
function notAUrl(name: string, value: string): string {
  const hostOnly = HOST_ONLY.test(value);
  return hostOnly
    ? `${varName(name)} holds a host name, not a connection URL: put the whole connection string there (postgresql://user:password@host:5432/postgres; Supabase › Connect › Session pooler shows it), or remove it to use the Supabase variables`
    : `${varName(name)} isn’t a Postgres connection URL (postgresql://user:password@host:5432/postgres)`;
}

/**
 * A connection string as given. A Supabase one also gets what finding its session pooler needs: the
 * poolers to fall back on when the region is known, the project, and the other passwords to try.
 */
export function databaseUrlOf(url: string, from: string, env: Env): DatabaseUrl {
  if (PASSWORD_PLACEHOLDER.test(url)) return { problem: `${from} still has [YOUR-PASSWORD] in it: put the database password there (Supabase › Project Settings › Database)` };
  const ref = supabaseRefOf(url);
  if (!ref) return { url, from };
  const parts = parsePgUrl(url);
  const info = supabaseInfo(ref, env, url);
  const more = isSupabaseDirect(url) && parts?.password ? poolerHosts(info).map((h) => poolerUrl(url, ref, h)) : [];
  const passwords = otherPasswords(env, parts?.password);
  return { url, from, ...(more.length ? { more } : {}), supabase: info, ...(passwords.length ? { passwords } : {}) };
}

/** Where the project's pooler is said to be: a named host, a pooler host in another variable, a region. */
function supabaseInfo(ref: string, env: Env, url?: string): SupabaseInfo {
  const named = SUPABASE_POOLER_KEYS.map((k) => env[k]?.trim()).find((v) => v && POOLER_HOST.test(v));
  const inUrl = url ? POOLER_HOST.exec(parsePgUrl(url)?.host ?? '')?.[0] : undefined;
  const elsewhere = named ?? Object.values(env).map((v) => (v ? POOLER_IN_TEXT.exec(v)?.[1] : undefined)).find(Boolean);
  const host = (inUrl ? undefined : elsewhere)?.toLowerCase();
  const region = SUPABASE_REGION_KEYS.map((k) => env[k]?.trim()).find((v) => v && REGION.test(v)) ?? (host ? POOLER_HOST.exec(host)?.[2] : undefined);
  return { ref, ...(region ? { region } : {}), ...(host ? { host } : {}) };
}

/** The Supabase password variables, URL-encoded, but the one the connection string has already. */
function otherPasswords(env: Env, have: string | undefined): OtherPassword[] {
  const out: OtherPassword[] = [];
  for (const key of SUPABASE_PASSWORD_KEYS) {
    const raw = env[key];
    if (!raw) continue;
    const value = encodeURIComponent(raw);
    if (value === have || safeDecode(have ?? '') === raw || out.some((o) => o.value === value)) continue;
    out.push({ from: varName(key), value });
  }
  return out;
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

// ---------------------------------------------------------------- connection strings

export interface PgUrl {
  readonly scheme: string;
  readonly user?: string;
  /** As written (URL-encoded). */
  readonly password?: string;
  readonly host: string;
  readonly port?: string;
  readonly database?: string;
  /** With its "?". */
  readonly query?: string;
}

/** A postgres:// connection string's parts (the password as written), or undefined. */
export function parsePgUrl(url: string): PgUrl | undefined {
  const m = /^(postgres(?:ql)?):\/\/(?:(.*)@)?([^@/:?]+)(?::(\d+))?(?:\/([^?]*))?(\?.*)?$/i.exec(url.trim());
  if (!m) return undefined;
  const info = m[2];
  const colon = info === undefined ? -1 : info.indexOf(':');
  const user = info === undefined ? undefined : colon >= 0 ? info.slice(0, colon) : info;
  const password = info !== undefined && colon >= 0 ? info.slice(colon + 1) : undefined;
  return { scheme: m[1]!, ...(user ? { user } : {}), ...(password !== undefined ? { password } : {}), host: m[3]!, ...(m[4] ? { port: m[4] } : {}), ...(m[5] ? { database: m[5] } : {}), ...(m[6] ? { query: m[6] } : {}) };
}

export function formatPgUrl(p: PgUrl): string {
  const auth = p.user !== undefined ? `${p.user}${p.password !== undefined ? `:${p.password}` : ''}@` : '';
  return `${p.scheme}://${auth}${p.host}${p.port ? `:${p.port}` : ''}/${p.database ?? 'postgres'}${p.query ?? ''}`;
}

/** The Supabase project a connection string goes to: db.<ref>.supabase.co, or a pooler's user postgres.<ref>. */
export function supabaseRefOf(url: string): string | undefined {
  const p = parsePgUrl(url);
  if (!p) return undefined;
  const direct = DIRECT_HOST.exec(p.host)?.[1];
  if (direct) return direct.toLowerCase();
  if (!POOLER_HOST.test(p.host)) return undefined;
  const ref = /\.([a-z0-9]{15,40})$/i.exec(p.user ?? '')?.[1];
  return ref?.toLowerCase();
}

/** Supabase's direct address (IPv6 only). */
export const isSupabaseDirect = (url: string): boolean => DIRECT_HOST.test(parsePgUrl(url)?.host ?? '');

/** A connection string's host. */
export const hostOf = (url: string): string => parsePgUrl(url)?.host ?? '';

/**
 * The session pooler hosts to try for a project, in order: the host named, else its region's two
 * (aws-0, aws-1), else every region's (`all`), so the one that knows the project is found by asking.
 */
export function poolerCandidates(info: Pick<SupabaseInfo, 'region' | 'host'> = {}, all = true): string[] {
  const first = poolerHosts(info);
  const rest = all ? SUPABASE_REGIONS.flatMap((r) => [`aws-0-${r}.pooler.supabase.com`, `aws-1-${r}.pooler.supabase.com`]) : [];
  return [...new Set([...first, ...rest])];
}

/** What the variables say the pooler is: the host named, or the region's two. */
function poolerHosts(info: Pick<SupabaseInfo, 'region' | 'host'>): string[] {
  if (info.host) return [info.host];
  return info.region ? [`aws-0-${info.region}.pooler.supabase.com`, `aws-1-${info.region}.pooler.supabase.com`] : [];
}

/**
 * A connection string to the project's session pooler at `host`, from one to it (direct or pooled):
 * the user gets the project (postgres → postgres.<ref>), the password and database stay.
 */
export function poolerUrl(from: string, ref: string, host: string): string {
  const p = parsePgUrl(from);
  const user = p?.user ?? 'postgres';
  return formatPgUrl({ scheme: 'postgresql', user: user.includes('.') ? user : `${user}.${ref}`, ...(p?.password !== undefined ? { password: p.password } : {}), host, port: '5432', database: p?.database ?? 'postgres', ...(p?.query ? { query: p.query } : {}) });
}

/** The same connection string with another (URL-encoded) password. */
export function withPassword(url: string, password: string): string {
  const p = parsePgUrl(url);
  return p ? formatPgUrl({ ...p, user: p.user ?? 'postgres', password }) : url;
}

/** A connection string to show: the password as Supabase › Connect shows it, [YOUR-PASSWORD]. */
export function hidePassword(url: string): string {
  const p = parsePgUrl(url);
  return p ? formatPgUrl({ ...p, ...(p.user !== undefined ? { password: '[YOUR-PASSWORD]' } : {}) }) : 'postgres://…';
}

/**
 * Supabase's connection string, made from its parts: its session poolers when the region is
 * known (they work on every network), else the direct address (its pooler is then looked for).
 * Without the database password it says where to find it: the API keys in .env don't open the database.
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
  const from = `Supabase (${ref}) and ${varName(passwordKey)}`;
  const info = supabaseInfo(ref, env);
  const direct = `postgresql://postgres:${password}@db.${ref}.supabase.co:5432/postgres`;
  const [first, ...more] = poolerHosts(info).map((h) => poolerUrl(direct, ref, h));
  if (first) return { url: first, from, ...(more.length ? { more } : {}), supabase: info };
  return { url: direct, from, supabase: info };
}

// ---------------------------------------------------------------- what went wrong

/**
 * Why psql couldn't run a query, in kinds the connector acts on:
 * - `no-ipv6`: Supabase's direct address didn't answer (it is IPv6 only, and this network has none);
 * - `unreachable`: another server didn't answer at all;
 * - `wrong-pooler`: a Supabase pooler that doesn't know the project (the wrong region, or aws-0 for aws-1);
 * - `wrong-password`: the server answered, and refused the password;
 * - `other`: the database answered something else (bad SQL, a missing table): the connection works.
 */
export type PgProblem = 'no-ipv6' | 'unreachable' | 'wrong-pooler' | 'wrong-password' | 'other';

export function classifyPgError(message: string, url?: string): PgProblem {
  if (/password authentication failed|SASL authentication failed|invalid password/i.test(message)) return 'wrong-password';
  if (/tenant(\/user)? .*not found|Tenant or user not found/i.test(message)) return 'wrong-pooler';
  const dead = /timeout expired|timed out|Took longer than|could not translate host|nodename nor servname|Name or service not known|no address associated|Network is unreachable|No route to host|Connection refused|could not connect to server|connection to server .* failed: (?!FATAL)/i.test(message);
  if (!dead) return 'other';
  return url && isSupabaseDirect(url) ? 'no-ipv6' : 'unreachable';
}

/** psql couldn't reach the server at all (worth trying the next address), rather than an answer like a wrong password or bad SQL. */
export function unreachable(message: string): boolean {
  const kind = classifyPgError(message);
  return kind === 'unreachable' || kind === 'wrong-pooler';
}

/** An error's text with the connection string (and its password) taken out. */
export function scrubbed(message: string, url: string): string {
  let out = message.split(url).join('postgres://…');
  const password = parsePgUrl(url)?.password;
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
