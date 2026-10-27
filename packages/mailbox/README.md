# Beluga mailbox

A Cloudflare Worker that holds sealed frames for friends who are never online at the same time
(BLG-272). A Mac posts a frame here when a friend's Mac hasn't acknowledged it for a while
(settings `mailboxAfterMin`, default 2), or at once when you quit; the friend's Mac takes its mail when it starts, wakes, and
every few minutes while some friend is offline. Frames are sealed to the recipient's box key and
signed by the sender: the Worker sees who wrote to whom, when and how much, never what.

The rules live in `src/net/mailbox/handler.ts` (tested in `tests/team/mailbox.test.ts`); this
package only stores rows in a SQLite-backed Durable Object per mailbox, kept 7 days.

```console
$ cd packages/mailbox
$ npx wrangler login
$ npx wrangler deploy
```

Then set its URL as `DEFAULT_MAILBOX_URL` in `src/net/mesh/mailbox.ts`, or per Mac:
`"mailbox": "https://…workers.dev"` in `~/.beluga/settings.json` (or `BELUGA_MAILBOX`; `"off"` turns it off).

Fits the Workers Free plan for a group of friends: 100,000 requests a day. Each Mac checks every
3 minutes only while a friend is offline (at most ~500 checks a day), plus one request per frame
that had to wait.
