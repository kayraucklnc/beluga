import { DurableObject } from 'cloudflare:workers';
import { MAIL_TTL_MS, type MailItem, type MailStore, handleMailbox } from '../../../src/net/mailbox/handler.js';

/**
 * Beluga's mailbox on Cloudflare: one Durable Object per mailbox (by the owner's peer id), its mail
 * in that object's SQLite. Everything the requests mean is in src/net/mailbox/handler.ts; this only
 * stores rows and wakes once a day to drop mail older than 7 days.
 */

interface Env {
  readonly BOX: DurableObjectNamespace<Mailbox>;
}

const DAY_MS = 86_400_000;

export class Mailbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS mail (id TEXT PRIMARY KEY, sender TEXT NOT NULL, key TEXT NOT NULL, sealed TEXT NOT NULL, sig TEXT NOT NULL, at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS mail_at ON mail (at)');
  }

  private store(): MailStore {
    const sql = this.sql;
    return {
      has: async (id) => sql.exec('SELECT 1 FROM mail WHERE id = ?', id).toArray().length > 0,
      put: async (m) => {
        sql.exec('INSERT OR IGNORE INTO mail (id, sender, key, sealed, sig, at) VALUES (?, ?, ?, ?, ?, ?)', m.id, m.from, m.key, m.sealed, m.sig, m.at);
      },
      usage: async (from) => {
        const row = sql.exec('SELECT COUNT(*) AS items, COALESCE(SUM(LENGTH(sealed)), 0) AS bytes, COALESCE(SUM(sender = ?), 0) AS fromOne FROM mail', from).one();
        return { items: Number(row.items), bytes: Number(row.bytes), fromOne: Number(row.fromOne) };
      },
      list: async (limit) =>
        sql
          .exec('SELECT id, sender, key, sealed, sig, at FROM mail ORDER BY at LIMIT ?', limit)
          .toArray()
          .map((r): MailItem => ({ id: String(r.id), from: String(r.sender), key: String(r.key), sealed: String(r.sealed), sig: String(r.sig), at: Number(r.at) })),
      remove: async (ids) => {
        for (const id of ids) sql.exec('DELETE FROM mail WHERE id = ?', id);
      },
      expire: async (before) => {
        sql.exec('DELETE FROM mail WHERE at < ?', before);
      },
    };
  }

  async fetch(req: Request): Promise<Response> {
    const to = new URL(req.url).pathname.split('/')[3] ?? '';
    const res = await handleMailbox(req, to, this.store());
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    return res;
  }

  async alarm(): Promise<void> {
    await this.store().expire(Date.now() - MAIL_TTL_MS);
    const left = this.sql.exec('SELECT COUNT(*) AS n FROM mail').one();
    // An empty mailbox costs nothing: no alarm until mail comes again.
    if (Number(left.n) > 0) await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split('/');
    if (url.pathname === '/' || url.pathname === '/v1/health') return new Response('Beluga mailbox: sealed frames for friends who are offline. Nothing here is readable but by its recipient.\n');
    if (parts[1] !== 'v1' || parts[2] !== 'mail' || !/^[\w-]{32}$/.test(parts[3] ?? '')) return new Response('Not found', { status: 404 });
    return env.BOX.get(env.BOX.idFromName(parts[3]!)).fetch(req);
  },
};
