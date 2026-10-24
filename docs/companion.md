# Beluga for phones (the companion)

A phone app for one person: you. It shows what your Mac's Beluga is doing and lets you answer,
ask and chat from it. It has no daemon, no Claude and no projects of its own: every screen is a
view of your Mac, and every button is a call to your Mac. Android first; iOS from the same code.

Code: `src/companion/` (the Mac side: pairing, the device link, views, what the phone may call),
`packages/companion/` (the app). This page is the design; `CLAUDE.md` has the rules that keep the
two in step.

## What it is for

| On the phone | Not on the phone |
|---|---|
| What needs you: approvals, Claude's questions, friends' requests, plan decisions, with a push notification | Code in conversations: no diffs, no code blocks in answers (they show as a "code · 24 lines" chip) |
| Live work: conversations, Claude's answers, sub-agents and their steps | Changes, review, commit; git writes beyond Merge |
| Outputs: screenshots, images, logs, test output, reports, PDFs (anything `isArtifact` calls an output) | Editing any file, from anywhere |
| A worktree's **Files**, read-only: browse, search by name, read source with colours (BLG-42) | Secrets (`isSecretPath`), whatever the screen |
| A worktree's **Terminal**, interactive: the same session as the Mac's terminal dock, both typing (BLG-42) | The Mac's other shells, or files outside a worktree |
| Plans as they're designed and run: milestones, tasks, decisions | Editing plans' structure (approve, decide and comment only) |
| Asking your Mac to do anything (Your Mac, a new worktree, plan or question in a project, or a message in a conversation), and getting the answer, images and files back | Settings beyond the phone's own (notifications, sign out) |
| Chats with friends (DMs, channels, files, Ask Claude); asking a friend's Claude (`ask_person`) | Hosting rooms, invites |
| Your Claude allowance (5-hour and weekly windows), and your friends' | Billing |

Text is never blocked: a `.log`, `.txt`, `.json`, `.md`, `.csv` an agent wrote or a test produced
opens in the text viewer. In a conversation's outputs, source code is held back, with the same rule the Mac's Outputs tab
already uses (`src/core/claude-code/outputs.ts` `isArtifact`: pictures anywhere; text outside the
project or in the folders outputs go to, like `.beluga/scratch`, `test-results`, `coverage`).
Secrets (`isSecretPath`) are never sent, whatever the file. Source code reaches the phone in one
place only: a worktree's Files, read-only ("Files and Terminal" below).

```beluga-graph
{"title": "How the phone reaches your Mac", "summary": "One encrypted link, opened only while you look", "direction": "right",
 "nodes": [
  {"id": "ui", "type": "client", "label": "App screens", "sublabel": "React Native · packages/companion/app", "group": "phone"},
  {"id": "worklet", "type": "service", "label": "Link worklet", "sublabel": "Bare · hyperdht + Noise", "group": "phone", "emphasis": true},
  {"id": "phone", "type": "group", "label": "Your phone"},
  {"id": "dht", "type": "external", "label": "Hyperswarm DHT", "sublabel": "finds your Mac, punches the hole"},
  {"id": "host", "type": "service", "label": "CompanionHost", "sublabel": "src/companion/host.ts", "group": "mac", "emphasis": true},
  {"id": "views", "type": "function", "label": "Views", "sublabel": "src/companion/views.ts", "group": "mac"},
  {"id": "api", "type": "service", "label": "Daemon API", "sublabel": "src/ipc/api.ts, phone allowlist", "group": "mac"},
  {"id": "mac", "type": "group", "label": "Your Mac"},
  {"id": "push", "type": "external", "label": "Beluga Push", "sublabel": "blind relay → FCM / APNs"}
 ],
 "edges": [
  {"from": "ui", "to": "worklet", "label": "RPC", "kind": "call"},
  {"from": "worklet", "to": "dht", "label": "lookup", "kind": "flow"},
  {"from": "worklet", "to": "host", "label": "Noise stream (pinned keys)", "kind": "data"},
  {"from": "host", "to": "views", "label": "subscribed topics", "kind": "call"},
  {"from": "host", "to": "api", "label": "allowed calls", "kind": "call"},
  {"from": "host", "to": "push", "label": "sealed nudge", "kind": "async"},
  {"from": "push", "to": "ui", "label": "notification", "kind": "async"}
 ],
 "steps": [
  {"title": "1. You open the app", "text": "The worklet starts, looks your Mac up on the DHT and opens one Noise stream to it. Only your phone's key gets through the Mac's firewall.", "focus": ["worklet", "dht", "host"]},
  {"title": "2. The screen subscribes", "text": "The phone names the topics on screen (home, one conversation). The Mac sends each as a small, finished view, and again when it changes.", "focus": ["host", "views"]},
  {"title": "3. You act", "text": "Approve, answer, send: a call to the same API the Mac app uses, if it's on the phone's allowlist.", "focus": ["ui", "api"]},
  {"title": "4. You put it away", "text": "Fifteen seconds in the background and the link closes and the DHT node stops: no radio, no battery.", "focus": ["worklet"]},
  {"title": "5. Something needs you", "text": "The Mac seals a nudge to the phone's key and sends it through Beluga Push. The phone shows it; acting on it opens the link for a second.", "focus": ["host", "push", "ui"]}
 ]}
```

## Signing in: your phone is a device of you

Beluga has no accounts: you are your Ed25519 identity (`~/.beluga/identity.json`). The identity's
private key never leaves the Mac. The phone gets its own key and a **device certificate** your
identity signs, so it can prove it speaks for you without being able to sign as you.

1. **Mac › Settings › Phone › Pair a Phone** opens a one-time pairing (`beluga://device#<secret>`,
   128 bits, 10 minutes, one use) as a QR code, plus a short code to type (`K7QM-4XPA-R2TD`, as
   friend codes, but stretched with Argon2id at 64 MiB so the phone can do it with sodium; works
   for 10 minutes).
2. The phone makes its device key (Ed25519, kept in the Android Keystore-wrapped encrypted store;
   the iOS Keychain later), its link key pair (Noise) and its box key (X25519), all from one seed
   it keeps (keyed BLAKE2b, `device-crypto.ts` `deviceKeys`).
3. The phone dials the temporary key the secret derives (the technique of friend invitations,
   `invitations.ts` `pairingSecrets`, with keyed BLAKE2b and labels `beluga-device-*` so the phone
   needs only sodium), and the two sides trade proofs bound to that Noise handshake (`devProof`):
   nobody without the secret can sit in the middle. Everything the phone does here is in
   `src/companion/device-crypto.ts`, shared by both sides, sodium-universal and b4a only.
4. The Mac shows "Pair Kayra's Pixel 9?" with the phone's name and a 4-emoji fingerprint the phone
   shows too. You click Pair.
5. The Mac answers with the **device certificate**
   `{ v:1, owner: peerId, ownerKey, device: deviceKey, link: linkPublicKey, box: x25519, name, platform, issuedAt }`
   signed by the identity (`signText('beluga-device-v1', canonical(cert))`; the phone checks it with
   sodium's `crypto_sign_verify_detached`, the raw key being the SPKI's last 32 bytes), the Mac's companion
   address, your name and profile. Both keep it: the Mac in `~/.beluga/devices.json` (0600), the
   phone in its store.

From then on the phone dials your Mac's **companion address** (stable, HKDF of your identity,
`'companion-v1'`, separate from the mesh address so it works whether or not the network is on), and
the Mac's firewall lets in only link keys of certificates it issued and hasn't revoked. The Noise IK
handshake pins both ends: the phone knows it reached your Mac, the Mac knows which phone it is.

**Removing a phone** (Settings › Phone, or Sign Out on the phone) deletes the certificate: the link
drops at once and the key is refused from then on. A lost phone is cut off from the Mac in one click.
Up to 4 phones.

Friends never see the phone. To them it is still you on your Mac; a chat message you send from the
phone is sent by your Mac, signed by your identity.

## The link

One Noise stream (`@hyperswarm/secret-stream` over hyperdht's UDX), framed as today's transport
(`[u32 length][u8 kind][payload]`), JSON messages validated by `src/companion/protocol.ts`:

| Phone → Mac | Mac → Phone |
|---|---|
| `hello {v, app, platform, topics}` | `welcome {v, min, mac, me}` (or close 4002 "update") |
| `sub {topics}`: what's on screen now | `view {topic, rev, data}`: a finished view, replacing the last |
| `call {id, method, args}`: an API call on the allowlist | `result {id, ok, value \| error}` |
| `get {id, ref, variant: thumb \| full \| text, off}` | `chunk {id, off, b64, eof, size, mime}` |
| `push {platform, token, relayKey}` (register for notifications) | `nudge {kind, title, body, topic}` (while linked, in place of a push) |
| `put {id, name, mime, size, off, b64, eof}`: a photo or file for the Mac, in pieces | `result {id, value: {received} \| {ref}}`: the last piece's `up:` ref |
| `term_attach {term}` / `term_detach {term}` (1.7): a terminal on screen | `term_status {term, running, exit?, cols, rows, gone?}`, then `term_data {term, data, reset?}` as it comes (~30 a second) |
| `term_input {term, data}` (1.7): keys typed on the phone | (the session's own echo, in `term_data`) |
| `bye` | `bye {reason}` |

**Views, not state.** The Mac's shared state is several MB and full of things the phone mustn't
show. The phone never sees it: `src/companion/views.ts` turns it into small views per topic, each
already cut down for the phone (code stripped, steps in words, paths as opaque refs):

- `home`: the Mac (name, awake), your usage, what needs you, what's running now, unread counts, tasks
  waiting for your review (1.3), and Your Mac's summary (`assistant`, 1.5). Outputs aren't listed here any more (1.3: `outputs` is sent empty);
  each running conversation says how many it made since its latest run began (`fresh`).
- `work`: projects (with their icon's checksum, 1.3) and their conversations (title, status, last line):
  the chats and worktrees you started. A project's main checkout has no conversation of its own
  (BLG-70): one from before became an ordinary chat in its project, listed like any other, and
  `conv:ws:<main>` isn't a conversation the phone can send to. Your Mac isn't a project either.
- `conv:<channel>`: one conversation (`conv:mac:assistant` is Your Mac, 1.5): turns (your messages, Claude's answers), what a running turn
  is doing now (`live`: thinking, writing, the step with its tool, time and count) and its steps in
  words with their tools (`trail`), sub-agents (title, status, steps, their own live step, kind,
  outputs), everything its worktree made (`outputs`: scratch files, reports, its Claude's and
  sub-agents' outputs, newest first), your queued messages (`queue`), where a merge started from the
  phone stands (`merge`), its pending question or approval.
- `plans` and `plan:<id>`: milestones, tasks and their status, decisions waiting. Since 1.5 a plan
  carries how it runs (`autonomy`, `paused`, `parallel`, `running`), each milestone what it waits on
  (`dependsOn`), each task its goal, acceptance, the tasks it waits on (`blockedBy`) and why.
- `tasks` and `task:<id>` (1.3): the board by project and status (key, title, priority, who has
  it); a task's goal, acceptance with ticks, activity, worktree and pull request, and where it may
  be moved.

**Drawn blocks (1.3).** What Claude drew for the screen in an answer (a `beluga-view`: table,
chart, stats, code, colors; a `beluga-graph`; `beluga-tasks`) goes along with its code chip entry
(`code[n].block`, its JSON as written). The phone reads it with the Mac's own parsers and models
(`src/shared/view-spec.ts`, `graph-spec.ts`, `src/shared/render/`) and draws it natively. A view's
source never runs on the phone: `companion.viewFetch` names the view (conversation, turn, block) and
the Mac runs its source as `view.fetch` does for the window, only for your own Claude's answers and
only sources the view names. Any other code still never leaves the Mac.

**Tables written as text (BLG-71).** Claude often draws a table as text: box characters
(`┌─┬─┐ │ ├─┼─┤`), a `+---+---+` grid, pipes over a rule, or columns lined up over dashes. The Mac
reads them (`src/shared/render/text-table.ts`, in `stripCode`), in the prose or as a fenced block
that is only a table, and sends each as a table view block (the spec Markdown tables make,
`md-table.ts` `tableSpec`), so the phone draws it with the same table as Markdown tables and views;
any phone since 1.3 reads it. One that only looks like a table goes as a `text` block (1.5), shown
monospaced and never wrapped, scrolling sideways. Changes keep their signs ("+4.9%").

**More blocks drawn (1.9, BLG-87).** `stripCode` also reads what a plain code block really is
(`src/shared/render/rich-fence.ts`): a file tree (├── └──) goes as a `tree` block, ```` ```json ````
as `json`, a shell session or command output as `terminal`, each as written, and the phone draws a
tree that folds, a colored JSON tree, a terminal with its colors. A ```` ```mermaid ```` diagram goes as
the `graph` or `view` it reads as (`mermaid.ts`), so any phone since 1.3 draws it. Math: display math
(`$$…$$`, `\[…\]`, ```` ```math ````) is a `math` block; inline math stays `$…$` in the words. The Mac
typesets both with MathJax (`src/companion/math-svg.ts`) into `ProseView.math`: SVG paths in
`currentColor`, sized in ex, which the phone draws with `react-native-svg`. Prices ("$5 and $10")
stay words (`src/shared/render/math.ts`). A phone before 1.9 shows a chip for the new kinds.

**Outputs and data on a small screen (BLG-71).** A turn's outputs are one strip that swipes
sideways: pictures as ~110 px thumbnails, text and logs as small cards (icon, name, size); a tap
opens the viewer, which swipes through that turn's outputs. Every table, chart, view and graph has
Expand: full screen, the one page of the app that turns sideways (`expo-screen-orientation`; the app
is otherwise kept upright). A table wider than the screen has a toggle by its row count: scroll
sideways, or cards (one per row, its columns as label and value).

**What came when.** A phone checks the Mac's minor (`welcome.v`, `SINCE` in protocol.ts) before it
subscribes to a newer topic or makes a newer call: an older Mac drops a whole `sub` frame that names a
topic it doesn't know. 1.7 brought a worktree's Files and Terminal (`SINCE.files`, `SINCE.terminal`).
1.8 brought a branch's every step from the phone (`SINCE.branchSteps`): the band at the top of a
worktree's conversation shows its state (Merged #7, Conflicts…), the step it needs next as a button
and the rest under Other Steps, the very steps of the Mac's toolbar (`BranchView.steps`), done with
`companion.branchStep`. Steps Claude does, and the ones that can't be undone, ask first; Merge into
the main folder keeps its sheet, and Open PR opens GitHub. That band is the one place for them: the
conversation's ••• doesn't repeat Merge. An older Mac's band only says the next step.
- `chats` and `chat:<conversation>`: friends' DMs and channels.
- `people`: friends, presence, their usage and what they let your Claude do.

A view is sent whole when it changes (by a hash), at most every 500 ms per topic: whole views are
simpler than patches and can't drift. A conversation view carries its last 40 turns; older ones come
with `call companion.older`.

**Files** travel only as refs the Mac handed out in a view (`out:<random>`), resolved on the Mac,
checked again with `isArtifact` and `isSecretPath` before a byte is read. Images come first as a
thumbnail (longest side 640 px, JPEG, made with `sips` and cached), the full image only when you open
it. Text comes as text (the first 256 KB, then more as you scroll; logs that grow follow their tail).
Everything is cached on the phone by checksum, so nothing is fetched twice.

**Calls.** The phone calls the daemon's own API (`src/ipc/api.ts`), validated by the same zod
schemas, through one allowlist: `src/companion/coverage.ts` classifies **every** API method as
`phone` or `mac`. Anything `mac` (git, the Mac's own `terminals.*` and `files.*`, editing,
settings…) is refused before it is parsed; a worktree's files and terminals reach the phone only
through `companion.files.*` and `companion.terminals` / `termOpen` / `termClose`. The type is `Record<Method, …>`, so a new API method doesn't compile until someone decides.

**Asking from the phone** (`src/ipc/companion-api.ts`, all `phone`):

- `companion.ask {target: {project} | {topic}, text, files?}` → `{topic}`: a question in a project
  (what New Chat does on the Mac, then `session.submit`) or a message in a conversation you can
  write in (Your Mac too: `{topic: 'conv:mac:assistant'}`). `files` are `up:` refs from `put` (25 MB a file, 10 a message): pictures go where
  pasted images go (`attachments.ts`, made smaller if they're too big for Claude), other files are
  named by their path in `~/.beluga/attachments/phone`. A ref works only for the phone that sent it.
- `companion.post {conversation, text, files?, ask?}`: a friends' chat message, files taken in as
  chat files.
- `companion.askPerson {peerId, text, needs?, project?}` → `{topic, task}`: a friend's Claude, as
  from their card on the Mac (`gateway.ask`; their approval and trust rules apply). It reads as the
  conversation `conv:task:<id>`: what you asked, their Claude's steps and answer, its files.
- `companion.signOut`: the calling phone's own certificate goes (never another's), its link closes.
- `companion.openOnMac {topic | need}` (1.3): every screen is told where to go (a navigate intent)
  and the Mac app's window comes to the front (its `raise` capability) → `{opened, why?}`.
- `companion.icon(sum)` (1.3): a project's icon, a PNG of at most 128 px (or a small SVG), by the
  checksum views carry; the phone keeps it by that checksum.
- `companion.mergeCheck` / `merge` / `resolve` (1.3): a worktree's merge, the Mac's own way (the
  Merge sheet's checks, the controller's merge, Solve merge conflict), followed in its `merge`.
- `companion.draftTask` / `addTask` (1.3): a task described in words, Claude's draft shown first.
- `companion.viewFetch` (1.3): a live view's rows (above).
- `workspaces.startWorktree(project, text, {plan?, quiet: true})` → the worktree's id, and
  `plans.create({projectId, goal})` → the plan (1.5): the Ask sheet's Worktree and Plan, the same
  calls as the Mac's project home (`plan`: Plan first, the Mac's Plan mode, on in it before Claude
  reads your words). A phone checks `SINCE.askModes` first; an older Mac gets a question.
- Also `phone` since 1.3: `board.move` and `board.start` (a task moved along, or started in a new
  worktree with Claude), and `session.submit` with `urgent` (Steer) next to `host.promote` and
  `host.cancelQueued` for the queue.

**Answering.** Every needs-you item carries its buttons as calls (`actions`), and, when it takes
picks or words, an `answer` template: call `method` with `args` after putting the answer at
`slot` (a path into the args; several picks joined with `join`). Claude's questions use
`questions.pick` for the earlier questions of a prompt and `questions.answer` for the last; a
friend's Claude's question `gateway.answer`; a milestone sent back `plans.sendBack`. Someone at the
door with your link: `invites.letIn` / `invites.decline`; someone asking to join a channel you
run: `network.groups.approve` / `decline`. Nothing appears without a way to answer it.

**Typed calls.** `src/companion/calls.ts` `PhoneCalls`: every `phone` method with its argument
tuple (the API's own zod) and its result; the app imports it rather than keeping a list.

## Files and Terminal (BLG-42)

A worktree's ••• menu has **Files** and **Terminal** next to Outputs (1.7, `SINCE.files`
and `SINCE.terminal`: a Mac too old just doesn't offer them).

**Files, read-only.** `companion.files.list(topic, path)` → a folder (folders first, pictures with a
`ref` for the image viewer), `companion.files.find(topic, query)` → names that match anywhere in the
worktree, `companion.files.read(topic, path, {off})` → a page of a file (512 KB of whole lines, its
language for colours). Everything goes through the companion's file gate
(`src/companion/worktree-files.ts`): the path stays inside that worktree (no absolute paths, no
`..`, nothing in `.git`); links are followed and where they really lead is checked again (out of
the worktree, or onto a secret under another name: refused, and not listed); `isSecretPath` (dotenv
files, keys, credential stores, Beluga's own files) is refused by name and by real path; secrets a
file holds are redacted as logs are. On the phone: a folder browser (breadcrumbs, folder and file
icons, search by name) and a viewer (monospace, line numbers, colours by language from a cheap
per-line tokenizer, wrap, find). There is no way to change a file. Claude's answers still go
through `stripCode`.

**Terminal, shared with the Mac.** The daemon runs one PTY per terminal (`src/terminal/pty-host.ts`);
the Mac app attaches to it over its local socket (`term_*` frames, `src/daemon/server.ts`), the
phone over the companion link (`src/companion/terminals.ts`). It's the very same session: both see
the same output live, and either can type.

- `companion.terminals(topic)` lists a worktree's terminals (its shell, setup and run, and shells
  started in its folder); `companion.termOpen(topic, {key? | fresh?})` opens one, its shell (started
  as the Mac's dock starts it, `terminals.shell`) or a new shell in its folder (`terminals.global`);
  `companion.termClose(key)` ends it for every screen (the phone asks first). Then `term_attach`,
  `term_input`, `term_detach` frames. Only terminals of your worktrees, never another of the Mac's
  shells by key.
- **Size: the Mac's.** The session keeps the Mac's grid (`cols × rows`, told in `term_status`, again
  when the Mac resizes it). The phone never resizes it: with two screens on one PTY the last resize
  wins, and the Mac's terminal would reflow under you each time you looked from the phone. The phone
  draws that grid fitted to its width; a pinch zooms in (then it pans sideways), one finger scrolls
  back, and the zoom is remembered.
- **Drawn by xterm.js in a WebView** (`react-native-webview`, an iframe in the web build), bundled
  with the app (`lib/terminal/xterm.generated.ts`, `npm run terminal:bundle`): no CDN, nothing
  fetched. Raw PTY bytes go in, so colours, cursor moves and full-screen programs draw as on the Mac.
  The page drops xterm's answers to the program's own queries (cursor position, device
  attributes): the Mac's screen answers those, once.
- **Keys.** A key bar above the keyboard: Esc, Tab, Ctrl (for the next key), ↑ ↓ ← → (in the
  program's cursor mode), |, ~, / and paste. No "Mac is typing": both just show.
- **Battery.** Output is coalesced on the Mac to one frame per ~33 ms, and streams only while the
  terminal screen is open: leaving it detaches, and the app going to the background (`focus
  {on: false}`) stops every stream; coming back attaches again and draws the screen afresh.
- **Safety.** This is running commands from the phone. It's allowed because it's your own paired
  device (the firewall, the pinned keys, the certificate you issued and can revoke), and it's
  logged on the Mac: which phone opened, started or closed which terminal, and how many characters
  it typed, never what.

## Any network

Kayra's dorm Wi-Fi put the phone and the Mac behind one public IP with client isolation: the DHT
lookup worked, the peer connection didn't. So the phone tries every way, quickly, and remembers
which one worked (`src/companion/dial.ts`):

| Way | How | Path shown |
|---|---|---|
| hyperdht | LAN address first when both share a public IP, then hole-punching | `lan` or `direct` |
| Relay | A WebSocket to the Mac's Cloudflare quick tunnel, Noise inside | `relay` |

- **Raced, not queued.** The way that worked last time on this network (kept per local subnet,
  `link-hints` in the app's storage) starts at once; the other starts 1.5 s later, or as soon as the
  first one fails. The first Noise handshake that opens with the Mac's key wins; the other is dropped.
- **The relay keeps end-to-end security.** The Mac's relay server (`src/companion/relay.ts`) listens
  on 127.0.0.1 and takes WebSockets at `/companion/<key>`; cloudflared (as rooms use it) makes it
  `wss://<name>.trycloudflare.com/companion`. Inside the socket runs the same Noise handshake as
  over hyperdht (secret-stream over the socket), the Mac answering as the key the phone dialed (its
  companion key, or an open pairing's). Both keys stay pinned, the frames, proofs and firewall are
  the same, and Cloudflare carries ciphertext only (`tests/companion-relay.test.ts` checks a tapping
  relay never sees plaintext). A removed phone is told 4010 inside the link, as over hyperdht.
- **Finding the relay.** Its URL changes whenever cloudflared restarts, so the Mac publishes it as
  a signed mutable record on the DHT (`RelayRecord`, hyperdht `mutablePut`) under its companion
  key and under each open pairing's keys, again every 10 minutes (`src/companion/reach.ts`). Pairing
  links carry it too (`beluga://device#<secret>?r=<url>`), so a QR works even where the DHT doesn't;
  a typed code finds it through the record. Each welcome says the current one; the phone keeps the
  last three.
- **On the phone**, Bare has no WebSocket, so the worklet asks the app's (React Native's, with the
  OS's TLS) through its IPC and passes ciphertext both ways in base64.
- **Only while needed.** The relay server and its tunnel run only while a phone is paired or a
  pairing is open, and not at all with Remote access set to direct only (`p2p`) or `none`, or in the demo.

## When it can't connect

The phone says what's wrong in plain words and what to do; a "Why?" sheet holds the detail (what
was tried, how each went) and Try again (`src/companion/diagnose.ts`, shared with the Mac). Before
blaming anything else it checks the phone is online at all (one look, only after a failure).

| Problem | Said |
|---|---|
| `offline` | This phone is offline |
| `dht-blocked` | This network blocks Beluga's connection (UDP blocked, and no relay) |
| `no-path` | Your Mac is there, but this network won't connect you: try mobile data |
| `mac-offline` | Your Mac isn't online: asleep, Beluga closed, or its network off |
| `pairing-gone`, `pairing-wrong`, `pairing-busy`, `pairing-full` | The pairing closed, ran out, was used; the code was off; another phone is pairing; 4 phones already |
| `update-mac`, `update-app` | Whose update would fix it |
| `removed` | This phone was removed: pair it again |

Pairing refusals carry a `why` for this (`dev_refused`), and the phone's `hello` says how it came
(`via {path, tried}`), so the Mac's Settings › Phone and the footer popover can say "Your phone found
this Mac but couldn't connect directly on its network, so it used the relay." The phone's
Settings › Advanced shows "Connected directly · same network / over the internet" or "Connected
through the relay (end-to-end encrypted)". Raw codes never reach the surface.

## Battery

The phone holds no connection it isn't using.

- **Open only while you look.** The worklet dials when the app comes to the front and closes 15 s
  after it goes to the background (the grace covers a quick app switch). Then the DHT node is
  destroyed: no UDP, no keepalives, no wakeups. Coming back is about one second (the DHT lookup and
  the handshake; the Mac's last direct address is tried first, and on the same Wi-Fi hyperdht
  connects over the LAN).
- **The relay costs nothing extra.** It's one more way to open the same link, open only while the
  app is in front and closed with it; the keepalives and views over it are the same. The phone
  never holds a relay socket in the background.
- **Quiet while open.** One keepalive every 20 s (UDP NAT mappings on mobile networks last about
  30 s). The Mac only sends the topics on screen, coalesced to one view per 500 ms; nothing is
  streamed character by character. Thumbnails before full images, cached by checksum.
- **No polling, ever.** When the app is closed it learns things only from push.
- **Push wakes it, briefly.** Something that needs you is a high-priority push; anything else is
  normal priority with a collapse key, so Android batches it and never wakes the radio for it.
  Approve or reply from the notification opens the link headless, makes one call and closes it again
  (a few seconds of radio).
- **The Mac decides when to push.** Only when you're not at the Mac (its idle time over 2 minutes,
  or the screen locked or asleep), and never for what you're already looking at on the phone. While
  linked, the Mac sends a `nudge` in-band instead.

## Notifications: Beluga Push

Android needs Firebase Cloud Messaging (and iOS needs APNs) to wake an app; both need a server
holding credentials. Beluga Push is that server and nothing more: a stateless relay (a Cloudflare
Worker), so the peer-to-peer design holds.

- The phone registers its FCM token with the relay and gets a `relayKey`; it gives the Mac
  `{token, relayKey}` over the link. Only someone holding the key can push to that phone.
- The Mac seals each notification to the phone's box key (`sealTo`, X25519 + AES-256-GCM) and posts
  `{token, sealed, priority, collapse}` signed with the relay key. The relay sees a token and
  ciphertext; FCM sees ciphertext; the phone opens it (an FCM data message, decoded in the app; on
  iOS a Notification Service Extension).
- Without the relay (not set up, or you turn it off), the app works the same while open; it just
  can't tell you anything while closed.

What notifies (each can be turned off on the phone): **Needs you** (approvals, Claude's questions,
friends' requests, plan decisions: with Approve / Decline or a reply right on the notification),
**Done** (a conversation you asked from the phone finished), **Mentions** (friends' chats).

## Using it: the screens

Small screen, thumbs, one hand. Friendly and calm: soft pastels (sky, mint, peach, lavender,
butter; rose for danger) as tinted backgrounds behind icons and chips, never glows or neon. Light
and dark themes follow the phone's own setting, or what you pick in Settings › Appearance
(System, Light or Dark). Dark is the Mac app's own dark grey (`#1e1e21`, cards `#2a2a2e`), not black, with the same
pastels toned down. Both themes take their neutrals from `packages/mac/src/styles/tokens.css`. Rounded cards, generous space, and icons everywhere (one rounded
set, an icon in a tinted circle for every row, tab and kind), with one word rather than a sentence.
Motion is smooth and purposeful: springs, shared transitions and haptics when something is
committed, and no decorative loops.

**The surface stays simple.** Each screen shows only its main action. Everything else is one tap
away, always in the same place: the ••• button or a long press opens a sheet (Always allow,
details, Open on your Mac, the model and project in Ask). Settings has the basics on top and
Advanced at the bottom. Learn it once and it works everywhere.

- **Home**: your Mac at the top (a small status dot: linked, away, asleep), and your allowance as
  two soft progress bars (5 hours and week, each with its percentage and reset time). Then **Needs you** as a
  stack of cards: swipe right to approve, left to decline, tap to read it whole, long-press for
  Always. Then **Running now**: each live conversation as a card with its project's icon, its step
  ticking over, its sub-agents as dots and a small count of new outputs. Then tasks **for your
  review**.
- **Work**: Conversations · Plans · Tasks. A conversation reads as cards: your message, Claude's
  answer (code folded into chips; views and graphs drawn), and while it works a live panel: thinking
  or writing with a soft shimmer, the step it's on with its tool, time and progress, the steps
  before it sliding in. Sub-agents are rows with their own live step; tap one for a sheet with its
  steps and its outputs. While Claude works the composer offers Steer (now) and Queue (after), and
  what's queued sits above it. The header's outputs button (and ••• › Outputs) shows everything the
  worktree made; ••• › Merge… checks, merges and gets conflicts resolved; ••• › Files reads the
  worktree's files and ••• › Terminal is its terminal, shared with the Mac (BLG-42). Images open full screen from where they are (shared
  transition): pinch, swipe between them, swipe down to put back. Text files open in a reader with
  search, wrap and "follow" for logs.
- **The Ask button** (in the middle of the tab bar, always there): "Ask your Mac…" with where it goes
  as one pill: **Your Mac** first and by default (a laptop), then a project, an open conversation,
  or a friend's Claude. A project offers three icon chips, as the Mac's project home: **Worktree**
  (the default: a new worktree with Claude on your words, then it opens), **Advanced plan**
  (Beluga's Plans, `plans.create`: Claude drafts milestones, tasks and what waits on what; the draft
  opens to approve) and **Question** (a read-only chat in its main folder). **Plan first** beside
  Worktree is Claude Code's plan mode (it proposes before it acts), nothing to do with Advanced plans. Attach a photo
  or a file from the phone. The answer comes back into that conversation, with a notification if you
  left.
- **Plans** (in Work and on Home when one runs): milestones as a vertical timeline (each says what it
  runs after), tasks as rows with their state and what they wait on (tap one for its goal and what
  done means), decisions as cards with their buttons (Approve or Discard a draft, pass a milestone's
  gate), how many run side by side, and how it runs as one chip (Step by Step, Check-ins, Autopilot:
  `plans.setAutonomy`).
- **Chats**: your friends' DMs and channels, as on the Mac, with photos and files both ways and
  Ask Claude.
- **People**: friends, their presence and allowance; tap one for Message, Ask their Claude, Take a
  screenshot of their desktop.

Everything has a state for "your Mac is asleep": the last views stay (cached on the phone, marked
"as of 10:42"), actions wait in a small outbox and go when the Mac answers (or you discard them).

**What you send shows at once; the Mac confirms it** (`packages/companion/lib/sends.ts`). A message
in a conversation or chat is drawn as yours straight away ("Sending…"). It counts as sent only when
the Mac answers the call, and its bubble goes only when the Mac's view has the message, so it is never
missing in between. A refusal leaves it "Not sent" with Retry and Remove, your words kept. If the link
drops before the answer, it says "Checking…" until the Mac's next view shows whether it arrived. A
start from Ask (a new worktree, a plan, a question, a friend's Claude) closes the sheet and opens its
Starting screen at once. That screen becomes the conversation or the plan when the Mac answers, or
goes back to Ask with your words and the reason. While the Mac is away, sends wait (kept across
launches) and go when it answers. `workspaces.startWorktree` answers once the worktree is made; the
model's name for it follows (the id stays).

## Your Mac (BLG-47)

One conversation with your own Claude for the whole Mac, not one project or worktree: "Take a
screenshot and send it to me", "What's using my CPU?", "Start a worktree in beluga for the login
bug", "Open a task to fix X". The same conversation on both screens: the Ask sheet's first target
and Home's compact **Ask your Mac** row on the phone (`conv:mac:assistant`, live steps, Steer and
Queue, outputs, as any conversation), the sidebar's top row on the Mac (the `assistant` view).

- **Where it runs.** `~/.beluga/assistant/work/` is its Claude's folder; its scratch folder is
  `work/.beluga/scratch/`. Its Claude session id (`state.json`) and its history (`history.json`) sit
  beside it. Everything in Beluga's home is secret to the phone (`isSecretPath`) except the folders
  Claude works in (`workspaces`, `chats`, `tasks/work`…): `assistant/work` joins them, narrowly, the
  way friends' tasks' `tasks/work` did, and nothing beside it does. Credentials are secret anywhere,
  so a `.env` in it still never leaves. Outside the home (`~/Beluga Assistant`) would have put a
  folder in your home you didn't make; inside, it's with Beluga's own and goes with it.
- **Whose Claude.** Yours, with your approvals as anywhere (commands ask unless you set never);
  edits only in its own folder go without asking. Nobody else can write in it.
- **Its tools** (`src/agent/mac-tools.ts`, server `beluga_mac`): `screenshot` (the main display or
  an app's window, with the gateway's `captureScreen`: saved in its scratch folder, so it reaches
  the phone as an output, and Claude sees a smaller copy; macOS's Screen Recording permission still
  applies), `device_info` (the gateway's), `list_work` (projects, worktrees and chats with ids, what
  runs, plans), `start_worktree` (a project, a first message, plan first), `start_task` (a board
  task in its own worktree), `start_plan`; and the board's tools (`task_create` in a named project,
  `task_update`…). Starting is quiet: the Mac's window stays where it is.
- **Links.** What it starts it names as `worktree:<id>`, `task:<KEY>` or `plan:<id>` in inline code;
  both screens draw a pill that opens it (`src/shared/render/inline-model.ts`).
- **Versions.** 1.5 (`SINCE.assistant`): an older Mac never gets the topic subscribed, and the Ask
  sheet doesn't offer Your Mac.

## On the Mac

- **The sidebar's footer** shows a phone mark when a phone is paired: lit with a dot while it's
  linked, outlined when it's away ("Pixel 9 · last seen 12 min ago" on hover). Click: the Phone
  popover (the devices, Pair a Phone…, Remove).
- **Settings › Phone**: pair (QR and code), the devices (name, platform, app version, last seen,
  notifications on or off), Remove, and Beluga Push (on by default once set up).
- **Shared state**: `companion: { devices: DeviceView[] }` (`linked`, `lastSeen`, `push`), never keys.

## Staying in step with the Mac app

The Mac app changes quickly; the phone must not fall behind silently.

1. **One API.** The phone calls `src/ipc/api.ts`, through `coverage.ts` (every method is `phone` or
   `mac`; a missing one is a compile error and a failing test). Renaming or changing a method's
   arguments changes it for both.
2. **Views are code next to the state.** `views.ts` reads `DomainState` directly: a change to the
   state that breaks a view breaks the typecheck. `tests/companion-views.test.ts` snapshots the views
   of the demo state, so a change that alters what the phone shows shows up in review.
3. **One protocol file, imported by both.** The app imports `src/companion/protocol.ts` from this
   repo (Metro `watchFolders`): within one commit the two can't disagree.
4. **Versions across releases.** `COMPANION_PROTO = { major, minor }`. Within a major, only additive
   changes: new topics, new fields, new needs-you kinds. The phone ignores what it doesn't know, and
   draws an unknown needs-you item as a generic card with "Open on your Mac". A breaking change bumps
   the major; the Mac keeps answering the previous major for one release, and the phone says "Update
   Beluga on your Mac" (or "Update the app") rather than misbehaving.
5. **CLAUDE.md** says it in words for every change (Claude reads it before working here).

## Phases

1. **This branch**: the contract (`protocol.ts`, `coverage.ts`), the Mac side (pairing, devices,
   `CompanionHost`, views, the footer mark, Settings › Phone), the app with Home, Work, a
   conversation, outputs, Needs you, Ask, Chats and People against a demo Mac, and the link worklet.
2. **Notifications**: Beluga Push (the Worker, a Firebase project), notification actions, Done and
   Mentions.
3. **iOS**: the same app; Keychain, APNs, the Notification Service Extension.
4. **Later**: screen sharing (ScreenCaptureKit → H.264 over the same link, on demand only), voice
   asks, a home-screen widget for usage and Needs you, other agents' allowance next to Claude's
   (the usage view is a list of providers, not one).

## Risks

- **Bare on Android.** The worklet runs Holepunch's Bare runtime (`react-native-bare-kit`, as Keet
  does) so hyperdht and its native UDP run unchanged on the phone. Where UDP or hole-punching
  fails, the relay (see "Any network") carries the same Noise link over a WebSocket.
- **The relay is Cloudflare's quick tunnel.** It has no uptime promise; when it's down the record
  says no relay and the phone explains. It only ever sees ciphertext.
- **A sleeping Mac can't answer.** The phone shows the last views and queues actions. Keeping the
  Mac awake while plugged in and Claude is working is already the Mac's choice to make, not the
  phone's.
- **Push needs a server.** Beluga Push sees which phone tokens get pushed, and when; never what.
