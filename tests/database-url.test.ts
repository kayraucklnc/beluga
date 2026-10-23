import { describe, expect, it } from 'vitest';
import { databaseUrl, scrubbed, supabaseRef } from '../src/core/views/database-url.js';

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
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'p@ss/w' })).toEqual({ url: `postgresql://postgres:p%40ss%2Fw@db.${REF}.supabase.co:5432/postgres`, from: `Supabase (${REF}) and $SUPABASE_DB_PASSWORD` });
    // With the region, the session pooler (it works on every network).
    expect(databaseUrl({ ...env, SUPABASE_DB_PASSWORD: 'pw', SUPABASE_REGION: 'eu-central-1' })).toMatchObject({ url: `postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` });
    // A connection string of its own wins.
    expect(databaseUrl({ ...env, DATABASE_URL: 'postgres://own' })).toMatchObject({ url: 'postgres://own' });
    expect(supabaseRef({ SUPABASE_PROJECT_REF: REF })).toBe(REF);
    expect(supabaseRef({ SUPABASE_URL: 'https://example.com' })).toBeUndefined();
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
