# Orca for Mac updates

Orca for Mac updates itself from GitHub Releases. The terminal app doesn't use this; it updates with `orca update` or npm.

## Klaud is now Orca

Copies installed as Klaud update to Orca like any other version: the old release URL redirects to `kayraucklnc/orca`, so they find the Orca build on their own. After the update, `~/.klaud` moves to `~/.orca` (with a link back), old `klaud://` links still open, and the terminal app's `klaud` command still works.

## What you see

- **When it looks.** Orca checks for a new version at launch, but only if the last check was more than 20 hours ago. While it runs, it checks once a day. After the Mac wakes, it checks if a check is overdue. A failed check is retried after an hour, so a normal launch makes no network request. You can also check by hand: **Orca › Check for Updates…**, or **Check Now** in Settings › General › Updates (also in Settings › About).
- **What happens when it finds one.** The update downloads in the background and its signature is verified. Then a small pill appears at the bottom of the sidebar, "Orca 0.5 is ready". If the sidebar is hidden, the pill sits in the window's corner. Clicking the pill opens a short sheet with the release notes and three choices:
  - **Restart Now** installs the update and reopens Orca where you were (the same workspace, project or place).
  - **Update When Idle** installs once all of these are true:
    - No Claude run is working or queued.
    - No program is running in Orca's terminals. A shell sitting at its prompt doesn't count.
    - Nobody is in your room, and you aren't in someone else's.
    - You haven't touched the Mac for 10 minutes.

    Orca then reopens quietly. If its window wasn't in front, it stays hidden in the menu bar and doesn't take focus.
  - **Later** installs the update the next time you quit Orca.
- **The Updates setting** (Settings › General): *Automatically when idle*, *Ask me* (the default), or *Off*. *Off* means Orca checks only when you ask. The sheet's "Always update when I'm idle" box switches to *Automatically when idle*.
- **Quitting.** A downloaded update always installs when you quit, unless updates are *Off*.
- **After an update.** The pill says "Updated to 0.5 · What's new" once.

## What an update restarts

Installing restarts Orca's engine, the daemon that the Mac app bundles. The new app runs its own daemon:

- On launch, a kept-alive daemon (one that a Mac app started) with a different version is stopped and replaced.
- A daemon the terminal app started is left alone.

**Kept** (on disk in `~/.orca`):

- projects, worktrees and workspaces
- each workspace's conversation
- each workspace Claude's session, which resumes with its context
- settings and trust
- your identity
- friends, groups, messages and presence on the Orca network, which reconnects by itself

**Lost:**

- Claude runs in progress and queued messages.
- Terminals and their scrollback. The shells start again.
- The room chat (it lives only in memory).
- The room-level Claude's context.
- Friends connected to your room. They drop out, and the **invite link changes**: each start makes a new room secret. They need the new link.
- If you had joined a friend's room, you're back in your own.
- The first time a workspace is opened after the restart, its history loads again.

That is why *Update When Idle* waits for Claude, the terminals and the room.

## Releasing

Releases are made from the maintainer's Mac, not CI: there's no workflow that publishes anything.
GitHub Actions only checks pull requests (`.github/workflows/ci.yml`, `mac.yml`).

**Orca for Mac** (tags `v<version>-mac`), from an up-to-date main:

```sh
cd packages/mac
npm run release -- --set-version 0.8.0          # tauri.conf.json + package.json; commit it (in the PR)
npm run release -- --notes ../../notes.md --dry-run   # build and write latest.json, upload nothing
npm run release -- --notes ../../notes.md       # build, then gh release create … --latest
```

Installed copies read `https://github.com/kayraucklnc/orca/releases/latest/download/latest.json`. The release marked *latest* must therefore carry `latest.json`.

The script ([scripts/release-mac.mjs](../scripts/release-mac.mjs)) does the following:

1. Refuses a version that isn't newer than GitHub's latest release.
2. Builds with `npm run app:build`, signing the update, and makes the `.dmg` (`packages/mac/scripts/make-dmg.mjs`).
3. Writes `latest.json` with the version, notes, `pub_date`, and `platforms["darwin-aarch64"]`. That entry holds the signature and the URL of the `.app.tar.gz` asset.
4. Creates the release, or updates it if it exists, and marks it latest.

The app's version is `version` in [packages/mac/src-tauri/tauri.conf.json](../packages/mac/src-tauri/tauri.conf.json); the window reads it from there. `packages/mac/package.json` must match, and a test checks that.

**The terminal app on npm** (`orca-code`, tags `v<version>`), from a clean main, logged in to npm (`npm login`, once):

```sh
npm run release:npm -- --dry-run   # typecheck, test, npm publish --dry-run
npm run release:npm                # publish, tag v<version>, push
```

If the version in package.json is already on npm, [scripts/release-npm.mjs](../scripts/release-npm.mjs) bumps the patch number and commits that. For a minor or major release, set the version in package.json first.

## The signing key

Updates are signed with a minisign key, separate from Apple's Developer ID.

- **Public key:** `plugins.updater.pubkey` in tauri.conf.json. An update that doesn't verify against it is never installed. `requireSignedVersion` is on, so the version in `latest.json` must also match the version that was signed.
- **Private key:** `~/.tauri/orca-updater.key` on the maintainer's Mac (mode 0600, no password; the release script also finds it under its name from before the rename). Never commit it or paste it anywhere. If it is lost, installed copies can't be updated any more, so keep a backup in a password manager.

## Trying an update locally

Debug builds can be pointed at a local server, so the whole flow can be tried without GitHub:

1. Build an older and a newer version with `tauri build --debug --bundles app`. For both builds, use a `--config` that changes the identifier and the `orca://` scheme (so they don't touch your installed Orca) and sets `plugins.updater.dangerousInsecureTransportProtocol`. Sign the newer build with `TAURI_SIGNING_PRIVATE_KEY`.
2. Serve the newer build's `.app.tar.gz` and a `latest.json` (written with `latestJson` from the release script) over `http://127.0.0.1`.
3. Start the older app with these variables:
   - `ORCA_HOME=<temp dir>`
   - `ORCA_UPDATE_ENDPOINT=http://127.0.0.1:<port>/latest.json`
   - `ORCA_UPDATE_IDLE_SECS=0` (to skip the 10 minutes)

   Run it from its real path (`/private/tmp/…`, not `/tmp/…`); the updater refuses symlinked paths.

Both variables are read only by debug builds.
