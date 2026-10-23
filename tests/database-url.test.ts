import { describe, expect, it } from 'vitest';
import { databaseUrl, scrubbed, supabaseRef, unreachable } from '../src/core/views/database-url.js';
import { secretIn } from '../src/shared/secret-text.js';

const REF = 'abcdefghijklmnopqrst';

describe('databaseUrl', () => {
  it('uses the variable a view names, and only for a Postgres connection string', () => {
    expect(databaseUrl({ MY_DB: 'postgres://u:p@h/db' }, 'MY_DB')).toEqual({ url: 'postgres://u:p@h/db', from: '$MY_DB' });
    expect(databaseUrl({}, 'MY_DB')).toEqual({ problem: expect.stringContaining('$MY_DB isn’t set') });
    // A token under that name never goes to psql (its error could show it).
    const wrong = databaseUrl({ STRIPE_KEY: 'sk_live_123' }, 'STRIPE_KEY');
    expect(wrong).toEqual({ problem: expect.stringContaining('isn’t a Postgres connection string') });
    expect(JSON.stringify(wrong)).not.toContain('sk_live_123');
  });

  it('finds the usual names by itself', () => {
    expect(databaseUrl({ POSTGRES_URL: 'postgresql://x' })).toEqual({ url: 'postgresql://x', from: '$POSTGRES_URL' });
    expect(databaseUrl({ DATABASE_URL: 'mysql://x', DIRECT_URL: 'postgres://y' })).toEqual({ url: 'postgres://y', from: '$DIRECT_URL' });
    expect(databaseUrl({})).toEqual({ problem: expect.stringContaining('No database found') });
  });

  it("makes Supabase's connection string from its variables", () => {
    const env = { NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co`, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'eyJ…' };
    expect(supabaseRef(env)).toBe(REF);
    // The API keys don't open the database: it says what's missing, and where to find it.
    const missing = databaseUrl(env);
    expect(missing).toEqual({ problem: expect.stringContaining('SUPABASE_DB_PASSWORD') });
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'p@ss/w' })).toMatchObject({ url: `postgresql://postgres:p%40ss%2Fw@db.${REF}.supabase.co:5432/postgres`, from: `Supabase (${REF}) and $SUPABASE_DB_PASSWORD` });
    // With the region, the session poolers (they work on every network): aws-0, then aws-1.
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'pw', SUPABASE_REGION: 'eu-central-1' })).toMatchObject({
      url: `postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres`,
      more: [`postgresql://postgres.${REF}:pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres`],
    });
    // Without it, the direct address, and a hint for when it can't be reached (it's IPv6 only).
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'pw' })).toMatchObject({ hint: expect.stringContaining('SUPABASE_REGION') });
    // A connection string of its own wins.
    expect(databaseUrl({ ...env, DATABASE_URL: 'postgres://own' })).toMatchObject({ url: 'postgres://own' });
    expect(supabaseRef({ SUPABASE_PROJECT_REF: REF })).toBe(REF);
    expect(supabaseRef({ SUPABASE_URL: 'https://example.com' })).toBeUndefined();
  });
});

describe('a connection string pasted from Supabase', () => {
  it('catches the [YOUR-PASSWORD] left in it', () => {
    expect(databaseUrl({ DATABASE_URL: `postgresql://postgres:[YOUR-PASSWORD]@db.${REF}.supabase.co:5432/postgres` })).toEqual({ problem: expect.stringContaining('[YOUR-PASSWORD]') });
  });

  it("falls back from the direct address to the region's poolers", () => {
    const url = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
    expect(databaseUrl({ DATABASE_URL: url, SUPABASE_REGION: 'us-east-1' })).toEqual({
      url,
      from: '$DATABASE_URL',
      more: [`postgresql://postgres.${REF}:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres`, `postgresql://postgres.${REF}:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres`],
    });
    expect(databaseUrl({ DATABASE_URL: url })).toMatchObject({ url, hint: expect.stringContaining('IPv6') });
  });

  it('tells a dead address from an answer', () => {
    expect(unreachable('psql: error: connection to server at "db.x.supabase.co", port 5432 failed: timeout expired')).toBe(true);
    expect(unreachable('psql: error: connection to server at "aws-0-x.pooler.supabase.com" failed: FATAL:  Tenant or user not found')).toBe(true);
    expect(unreachable('psql: error: connection to server failed: FATAL:  password authentication failed for user "postgres"')).toBe(false);
    expect(unreachable('ERROR:  relation "users" does not exist')).toBe(false);
  });
});

describe('scrubbed', () => {
  it('takes the connection string and its password out of an error', () => {
    const url = 'postgresql://postgres:hunter2%21@db.x.supabase.co:5432/postgres';
    const out = scrubbed(`connection to ${url} failed; password "hunter2!" rejected`, url);
    expect(out).not.toContain('hunter2');
    expect(out).toContain('postgres://…');
  });
});

describe('secretIn (a message to the room)', () => {
  it('spots a password or key before everyone sees it', () => {
    expect(secretIn('here: postgresql://postgres.abc:Hunter2pw@aws-1-eu-central-1.pooler.supabase.com:5432/postgres')).toBe('a connection string with its password');
    expect(secretIn('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.abc')).toBe('a secret value');
    expect(secretIn('my key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz')).toBe('an Anthropic API key');
    // Talking about them is fine.
    expect(secretIn('postgresql://postgres:[YOUR-PASSWORD]@db.x.supabase.co/postgres')).toBeUndefined();
    expect(secretIn('set DATABASE_URL in Settings and the password too')).toBeUndefined();
  });
});
