import { describe, expect, it } from 'vitest';
import { databaseUrl, type FoundDatabase } from '../src/core/views/database-url.js';
import { type PgMemory, type Psql, connectPostgres } from '../src/core/views/postgres-connect.js';

/**
 * Reaching Supabase over IPv4 (BLG-302), with a fake psql: its direct address never answers (no
 * IPv6 here), only aws-1-eu-central-1 knows the project, and only one password is right.
 */

const REF = 'abcdefghijklmnopqrst';
const RIGHT_POOLER = 'aws-1-eu-central-1.pooler.supabase.com';

function fakeSupabase(opts: { password?: string; pooler?: string; offline?: boolean } = {}): { psql: Psql; dialed: string[] } {
  const password = opts.password ?? 'right';
  const pooler = opts.pooler ?? RIGHT_POOLER;
  const dialed: string[] = [];
  const psql: Psql = async (url) => {
    dialed.push(url);
    const m = /^postgresql:\/\/([^:]+):([^@]*)@([^:/]+)/.exec(url)!;
    const [, user, pw, host] = m;
    if (opts.offline) throw new Error(`psql: error: could not translate host name "${host}" to address: nodename nor servname provided, or not known`);
    if (host!.startsWith('db.')) throw new Error(`psql: error: connection to server at "${host}" (2a05:d014::1), port 5432 failed: timeout expired`);
    if (host !== pooler || user !== `postgres.${REF}`) throw new Error(`psql: error: connection to server at "${host}" (3.1.2.3), port 5432 failed: FATAL:  Tenant or user not found`);
    if (decodeURIComponent(pw!) !== password) throw new Error(`psql: error: connection to server at "${host}" (3.1.2.3), port 5432 failed: FATAL:  password authentication failed for user "postgres"`);
    return '[{"n":6}]';
  };
  return { psql, dialed };
}

const fresh = (): PgMemory => ({ reached: new Map(), poolers: new Map() });
const found = (env: Record<string, string>): FoundDatabase => {
  const f = databaseUrl(env);
  if ('problem' in f) throw new Error(f.problem);
  return f;
};

describe('connectPostgres', () => {
  it('falls back from the IPv6-only direct address to the pooler that knows the project, by itself', async () => {
    const { psql, dialed } = fakeSupabase();
    const memory = fresh();
    const db = found({ DATABASE_URL: `postgresql://postgres:right@db.${REF}.supabase.co:5432/postgres` });
    await expect(connectPostgres(db, 'SELECT 1', 30_000, psql, memory)).resolves.toBe('[{"n":6}]');
    // It used the project's user on the right region's aws-1, and remembers it.
    expect(dialed.at(-1)).toBe(`postgresql://postgres.${REF}:right@${RIGHT_POOLER}:5432/postgres`);
    expect(memory.poolers.get(REF)).toBe(RIGHT_POOLER);
    // The next run dials it first, and only it.
    dialed.length = 0;
    await connectPostgres(db, 'SELECT 1', 30_000, psql, memory);
    expect(dialed).toEqual([`postgresql://postgres.${REF}:right@${RIGHT_POOLER}:5432/postgres`]);
  });

  it('tries the region named first, and finds the right family (aws-0 or aws-1)', async () => {
    const { psql, dialed } = fakeSupabase();
    const db = found({ DATABASE_URL: `postgresql://postgres:right@db.${REF}.supabase.co:5432/postgres`, SUPABASE_REGION: 'eu-central-1' });
    await connectPostgres(db, 'SELECT 1', 30_000, psql, fresh());
    expect(dialed.map((u) => /@([^:]+)/.exec(u)![1])).toEqual([`db.${REF}.supabase.co`, 'aws-0-eu-central-1.pooler.supabase.com', RIGHT_POOLER]);
  });

  it('retries with SUPABASE_DB_PASSWORD when the connection string’s password is refused', async () => {
    const { psql, dialed } = fakeSupabase();
    const db = found({ DATABASE_URL: `postgresql://postgres.${REF}:stale@${RIGHT_POOLER}:5432/postgres`, SUPABASE_DB_PASSWORD: 'right' });
    await expect(connectPostgres(db, 'SELECT 1', 30_000, psql, fresh())).resolves.toBe('[{"n":6}]');
    expect(dialed).toEqual([`postgresql://postgres.${REF}:stale@${RIGHT_POOLER}:5432/postgres`, `postgresql://postgres.${REF}:right@${RIGHT_POOLER}:5432/postgres`]);
  });

  it('says the password is wrong, which were tried, and the pooler’s string with the password hidden', async () => {
    const { psql } = fakeSupabase();
    const db = found({ DATABASE_URL: `postgresql://postgres:stale@db.${REF}.supabase.co:5432/postgres`, SUPABASE_DB_PASSWORD: 'also-wrong' });
    const err = await connectPostgres(db, 'SELECT 1', 30_000, psql, fresh()).catch((e: Error) => e.message);
    expect(err).toContain('The database refused the password (`$DATABASE_URL`’s, then `$SUPABASE_DB_PASSWORD`)');
    expect(err).toContain(`postgresql://postgres.${REF}:[YOUR-PASSWORD]@${RIGHT_POOLER}:5432/postgres`);
    expect(err).not.toContain('stale');
    expect(err).not.toContain('also-wrong');
  });

  it('says there is no IPv6 and no pooler knows the project, with what to put where', async () => {
    const { psql } = fakeSupabase({ pooler: 'nowhere.example' });
    const db = found({ DATABASE_URL: `postgresql://postgres:right@db.${REF}.supabase.co:5432/postgres` });
    const err = await connectPostgres(db, 'SELECT 1', 30_000, psql, fresh()).catch((e: Error) => e.message);
    expect(err).toContain(`Supabase’s direct address (db.${REF}.supabase.co) answers only over IPv6, and this network has none`);
    expect(err).toContain(`knows project ${REF}`);
    expect(err).toContain('in `$DATABASE_URL`');
    expect(err).toContain(`postgresql://postgres.${REF}:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`);
    expect(err).not.toContain(':right@');
  });

  it('stops looking when nothing answers at all (offline), and says so', async () => {
    const { psql, dialed } = fakeSupabase({ offline: true });
    const db = found({ DATABASE_URL: `postgresql://postgres:right@db.${REF}.supabase.co:5432/postgres` });
    const err = await connectPostgres(db, 'SELECT 1', 30_000, psql, fresh()).catch((e: Error) => e.message);
    expect(err).toContain('is this Mac online?');
    // The direct address, then one batch of poolers: not all of them.
    expect(dialed.length).toBeLessThanOrEqual(9);
  });

  it('passes a query error on as it is: the connection works', async () => {
    const psql: Psql = async () => {
      throw new Error('ERROR:  column "admin_id" does not exist');
    };
    const db = found({ DATABASE_URL: 'postgres://u:pw@db.example.com/app' });
    await expect(connectPostgres(db, 'SELECT admin_id FROM jobs', 30_000, psql, fresh())).rejects.toThrow('column "admin_id" does not exist (connecting with `$DATABASE_URL`)');
  });
});
