# Klaud for Mac becomes Beluga: the update bridge

Klaud for Mac (bundle id `sh.klaud.mac`, `Klaud.app`) is now Beluga (`io.github.kayraucklnc.beluga`,
`Beluga.app`). To macOS a new bundle id is a new app, with its own Application Support folder, its
own web view storage and its own notification permission. This page says how an installed Klaud
reaches Beluga and keeps everything. The code is in
[packages/mac/src-tauri/src/rename.rs](../packages/mac/src-tauri/src/rename.rs) and
[packages/mac/src/lib/storage-rename.ts](../packages/mac/src/lib/storage-rename.ts).

## How an installed Klaud gets to Beluga

There is no special "last Klaud" release. The first Beluga release is the bridge:

1. **Klaud finds it.** Installed copies read
   `https://github.com/kayraucklnc/klaud/releases/latest/download/latest.json`. GitHub redirects
   that (301) to `kayraucklnc/beluga`, whose latest release is Beluga. The update is signed with the
   same minisign key (`plugins.updater.pubkey` didn't change), so Klaud verifies and accepts it.
   **Never change the updater key in the same release as a rename:** Klaud would refuse the update.
2. **Klaud installs it the usual way.** The updater replaces the app it runs from, so Beluga's
   bundle lands at `/Applications/Klaud.app`. Klaud then relaunches that path (Restart Now, when
   idle, or the next time you quit and open it).
3. **Beluga moves itself.** On launch, before anything else, Beluga notices it runs from a folder
   named `Klaud.app`. It renames that folder to `Beluga.app` and registers it with Launch Services,
   so `beluga://` and `klaud://` links open it. Then it starts again from the new path, with the same
   arguments and environment. The old Klaud's quiet `--klaud-background` relaunch still counts. It
   stays put when:
   - `Beluga.app` is already there (for example, installed from the disk image), or
   - it runs from a disk image or from macOS's translocated copy, or
   - the rename fails because `/Applications` isn't writable. Beluga then just runs under the old
     folder name, and nothing breaks.

   The signature covers the bundle's contents, not its folder name, so renaming keeps it valid.
4. **Beluga brings Klaud's data over.** Still before Tauri starts, Beluga copies these folders under
   `~/Library` to their new names:

   | Klaud (`sh.klaud.mac`) | Beluga (`io.github.kayraucklnc.beluga`) | What's in it |
   |---|---|---|
   | `Application Support/sh.klaud.mac` | `Application Support/io.github.kayraucklnc.beluga` | `updates.json` (the Updates setting, "What's new"), `.window-state.json` (window size and place) |
   | `WebKit/sh.klaud.mac` | `WebKit/io.github.kayraucklnc.beluga` | the web view's localStorage, IndexedDB |

   A folder is copied only when Beluga's isn't there yet. The copy goes into a hidden temporary
   folder that is renamed into place at the end, so a copy that was cut short never counts. Klaud's
   folders are left as they were, so going back to an older Klaud still finds everything.
   Development builds (`tauri dev`, no bundle) copy `WebKit/klaud-mac` to `WebKit/beluga-mac`.
5. **The window renames its keys.** The first module the window loads moves every `klaud.*`
   localStorage key to `beluga.*`: prefs, the onboarding mark, plan and task layouts, sorts, the
   place to reopen after the update. A `beluga.*` key that already exists is never overwritten. So
   the welcome doesn't come back, and the window opens where you left it.
6. **The rest.**
   - Notification sounds are written as `~/Library/Sounds/Beluga-….wav`. The old `Klaud-….wav`
     files are removed the next time sounds are pruned.
   - The menu-bar icon's id, the notification action types and the relaunch argument now say
     beluga. The relaunch still reads Klaud's `--klaud-background`.

## What carries over without the bridge

- `~/.klaud` becomes `~/.beluga`, with a link back, the first time the core runs (src/core/home.ts).
  Until then the app reads `~/.klaud/daemon.json` (`beluga_home` in daemon.rs).
  `BELUGA_HOME` is read first, then `KLAUD_HOME` and `KLAUDE_HOME`.
- After an update the new app replaces a kept-alive daemon of another version, as before
  ([updates.md](updates.md)).
- Both schemes, `beluga` and `klaud`, are registered in tauri.conf.json, so old invites and deep
  links still open. New links say `beluga://`.

## What macOS asks again

- **Notifications.** The permission belongs to the bundle id, so macOS asks once more. Settings ›
  Notifications shows the state and opens System Settings at Beluga.
- **Focus.** If Klaud was an allowed app in a Focus, add Beluga there.
- **Login items, Full Disk Access, the Dock.** Anything granted to `Klaud.app` by name. The Dock
  usually follows the rename, because its items are bookmarks.

## Trying the bridge with a local update feed

The steps of [Trying an update locally](updates.md#trying-an-update-locally), with an old build
from before the rename and a new one from after it. Each gets its own `.bridge` identifier and
scheme, so neither touches your installed app:

1. Make a throwaway signing key:
   `npx tauri signer generate --ci -p "" -w /private/tmp/beluga-bridge/test.key`
2. Write two `--config` files. Both set `plugins.updater.pubkey` to the test key's `.pub`, set
   `endpoints: ["http://127.0.0.1:18765/latest.json"]` and set
   `dangerousInsecureTransportProtocol: true`.
   - The old one: `identifier: "sh.klaud.mac.bridge"`, `version: "0.9.0"`, scheme `klaudbridge`.
   - The new one: `identifier: "io.github.kayraucklnc.beluga.bridge"`, `version: "0.10.0"`,
     schemes `belugabridge` and `klaudbridge`.

   The `.bridge` suffix carries over: Beluga's `….beluga.bridge` reads Klaud's `sh.klaud.mac.bridge`.
3. Build the new app from this tree, signed with the key:
   `TAURI_SIGNING_PRIVATE_KEY="$(cat test.key)" npx tauri build --debug --bundles app --config new.json`.
   Build the old one from a checkout before the rename (`git archive <commit>`):
   `npx tauri build --debug --bundles app --config old.json`.
4. Serve `Beluga.app.tar.gz` and a `latest.json` that names it (with the `.sig` file's text as the
   signature) on `http://127.0.0.1:18765`.
5. Put the old `Klaud.app` in `/private/tmp/beluga-bridge/Applications/`. Give it
   `{"mode":"idle"}` in `~/Library/Application Support/sh.klaud.mac.bridge/updates.json`, start it
   with `KLAUD_HOME=<temp dir>` and `KLAUD_UPDATE_IDLE_SECS=0`, and leave the Mac alone for a
   minute.
6. Check the result:
   - `Klaud.app` is gone and `Beluga.app` runs from the same folder.
   - `Application Support/io.github.kayraucklnc.beluga.bridge` has `updates.json` (with
     `news.version` 0.10.0) and `.window-state.json`.
   - `WebKit/io.github.kayraucklnc.beluga.bridge` has the old localStorage, and its keys now say
     `beluga.*`.

   Afterwards, delete the `.bridge` folders in `~/Library/Application Support`, `~/Library/WebKit`
   and `~/Library/Caches`.
