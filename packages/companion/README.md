# Beluga for phones (the companion app)

The phone app for one person: you. Every screen is a view of your Mac's Beluga and every button is
a call to it (design: `docs/companion.md`; rules that keep it in step: `CLAUDE.md`). Android first;
iOS from the same code. Expo + React Native + TypeScript, expo-router, Reanimated, Gesture Handler.

## Run it

```sh
cd packages/companion
npm install
npm run web          # the app in a browser (react-native-web), demo mode works fully
npm start            # Expo dev server; `npm run android` for a device build
npm run typecheck    # the app (and the shared protocol it imports)
npm run typecheck:worklet   # the link worklet against src/companion/client.ts
```

**Demo mode**: on the pairing screen, tap **Try the demo**. A Mac inside the app
(`lib/link/demo/`) answers the protocol exactly as `src/companion/host.ts` does: projects, a
conversation at work with sub-agents taking screenshots and running a test log that grows, a plan,
something of every needs-you kind (and one unknown kind), friends' chats, usage 62% week / 18% 5h.
Approve, answer, send, ask a friend's Claude for a screenshot: it reacts. Settings › Advanced ›
Demo › Mac asleep shows the "your Mac is away" state (cached views marked "as of", an outbox).
Leave it from Settings.

## Structure

```
app/                 expo-router screens
  pair.tsx           pairing: scan the QR / type the code, the fingerprint check, or the demo
  (tabs)/            Home · Work · [Ask] · Chats · People (custom tab bar: components/TabBar.tsx)
  conv/[id].tsx      a conversation: turns, code as chips, drawn views and graphs, the live panel,
                     sub-agents, Steer/Queue and the queue, its outputs, Merge, Open on your Mac
  task/[id].tsx, tasks.tsx   a task's page (comment, move, Start with Claude); all tasks
  viewer.tsx         images full screen: opens from the thumbnail, pinch, swipe between, swipe down
  reader.tsx         text outputs (logs, txt, json, md): find, wrap, follow a growing log
  plan/[id].tsx      a plan: decisions, milestones as a timeline, tasks
  chat/[id].tsx      friends' DMs and channels; photos; Ask Claude
  person/[id].tsx    Message · Ask their Claude · Screenshot
  ask.tsx            the Ask sheet (target one tap away)
  needs.tsx, need/[id].tsx   all that needs you; one item's "•••" sheet (Always, open, details)
  settings.tsx       basics on top (Mac, notifications, appearance, sign out), Advanced below
components/          ui kit (Card, IconBadge, Pill, Row, Button, More), Sheet, Options, Needs
                     (the swipe stack), Conv, Outputs, Usage, Composer, Segments, Mark
components/Live.tsx  the live panel, steps with their tools, sub-agent rows (BLG-43)
components/render/   views (table, chart, stats, code, colors), graphs, inline elements (BLG-68)
lib/render.ts        the Mac's own parsers and drawing models, from src/shared (never copied)
lib/theme.ts         tokens: the Mac app's neutral greys + six pastels, light and dark
lib/appearance.ts    System / Light / Dark (follows the phone live; saved)
lib/store.ts         the one store: link state, views (+ cache), subscriptions, calls, outbox, files
lib/hooks.ts         useView(topic), useFile(ref), useLink(), ...
lib/link/
  protocol.ts        re-exports ../../src/companion/protocol.ts (never copied)
  transport.ts       the Transport interface the store uses
  rpc.ts             UI ⇄ worklet messages (newline JSON over BareKit.IPC)
  bare.ts            BareTransport: starts the worklet (bare.web.ts: none on the web)
  demo/              DemoTransport, its world (data.ts) and pictures (images.generated.ts)
  calls.ts           every API call the phone makes, in one place
worklet/link.ts      the Bare worklet: hyperdht + src/companion/client.ts (pairDevice, CompanionClient)
scripts/             make-demo-images.mjs, bundle-worklet.mjs
```

Design: soft pastels on the Mac's neutral greys; an icon in a pastel circle and a word or two
everywhere; the primary action on the surface and everything else behind "•••" (the same
`Options` sheet everywhere). No glow, no decorative loops; springs and haptics where something
moves because you moved it. No hard-coded colors outside `lib/theme.ts` (the brand mark's colors
are `brand` there).

## The link

`lib/store.ts` speaks the protocol frames (`hello`, `sub`, `call`, `get`, `focus`, `bye` /
`welcome`, `view`, `result`, `chunk`, `nudge`) to a `Transport`:

- `DemoTransport`: the in-app Mac.
- `BareTransport`: a Bare worklet (`react-native-bare-kit`) running `worklet/link.ts`, which wraps
  the Mac side's own client (`src/companion/client.ts`) and turns its events back into frames, so
  the store can't tell the two apart. Keys: the device seed lives in `expo-secure-store`
  (Keystore-wrapped); the worklet derives the device, link and box keys from it
  (`device-crypto.ts`).

Battery (docs/companion.md): the link opens when the app comes to the front and closes
`BACKGROUND_GRACE_MS` after it leaves; the worklet is terminated and the DHT node destroyed when
nothing needs it. Keepalive is the client's (`KEEPALIVE_MS`). Nothing polls: a growing log is
followed because its `size` changes in the conversation's view, not by asking.

**Bundling the worklet**: `npm run worklet:bundle` compiles `worklet/link.ts` and what it imports
from the repo with `tsc` (bare-pack can't map `./x.js` imports to `.ts`), then packs it with
`bare-pack --linked` into `worklet/dist/link.bundle.mjs` (git-ignored). Without the bundle, Metro
resolves the import to an empty module and only the demo works. The same script links the native
addons the bundle loads (udx-native, sodium-native, …) with `bare-link` into
`node_modules/react-native-bare-kit/android/src/main/addons` (the APK build picks them up) and
`node_modules/react-native-bare-kit/ios/addons` (the BareKit pod vendors them). The bundle covers
both platforms, so an `npm install` (whose `postinstall` re-runs it) never leaves one without its
addons; `-- --android` or `-- --ios` packs one only. Android needs minSdk 29 (react-native-bare-kit).

**End to end against a real Mac** (BLG-32): an emulator (API 35, arm64) paired with a demo daemon
in an isolated home, over the public DHT; scripts and screenshots in `.beluga/scratch/phone-e2e/`
(`bin/repair.sh` restarts the daemon and pairs the app).

## Staying in step with the Mac (CLAUDE.md)

- **One protocol file**: `lib/link/protocol.ts` re-exports `src/companion/protocol.ts`; Metro
  watches `src/companion` and resolves its imports (zod) from this package. A change there that
  breaks a screen breaks `npm run typecheck` here.
- **One API**: every call is typed through the Mac's `PhoneCalls` (`src/companion/calls.ts`:
  `PhoneMethod`, `PhoneArgs<M>`), type-only, in `lib/link/calls.ts`; a renamed method or a changed
  argument fails the typecheck. Needs-you items carry their own calls: `actions` are made as they
  are (a choice's own `plain` button when the Mac sends one); picks and words go through the item's
  `answer` template (put at `slot`, several picks joined with `join` or as a list).
- **Files to the Mac** go as `put` frames (`store.put` → an `up:` ref) and are named in
  `companion.ask` / `companion.post`.
- **Views are validated** with the protocol's zod schemas (`viewSchema`) as they arrive; one that
  doesn't match is dropped (and logged in dev), the last good one stays.
- **Unknown needs-you kinds** draw as a plain card with "Open on your Mac". Add new kinds to
  `components/Needs.tsx` (`kindOf`) when the Mac adds them.
- **Versions**: `welcome` is checked with `compatible()`; a mismatch shows "Update Beluga on your
  Mac" or "Update the app" instead of misbehaving.
- **The worklet** is typechecked against the real `client.ts` (`npm run typecheck:worklet`).

## iOS

The same app, built for iPhone (iOS 16.4+). `ios/` is generated (git-ignored), like `android/`:
`scripts/build-ios.mjs` makes it, and `app.json` / `app.config.js` / `plugins/` are what you change.
Needs a Mac with Xcode 26+ and CocoaPods (`brew install cocoapods`).

**On your iPhone, from Xcode**

```sh
cd packages/companion && npm install
export BELUGA_APPLE_TEAM_ID=ABCDE12345     # your team: developer.apple.com › Account › Membership details
npm run ios:prepare                        # worklet bundle (+ iOS addons), prebuild, pod install
open ios/Beluga.xcworkspace                # the .xcworkspace, not the .xcodeproj
npm start                                  # Metro, for a Debug build
```

In Xcode pick the **Beluga** scheme and your iPhone, and Run. Without `BELUGA_APPLE_TEAM_ID`, choose
the team under Beluga › Signing & Capabilities (Automatically manage signing stays on). If the
team can't register `sh.ratel.beluga` (an App ID belongs to one team), also set
`BELUGA_IOS_BUNDLE_ID=com.yourname.beluga` before `ios:prepare`. A Release build (Product › Scheme
› Edit Scheme › Run › Release) has the JS inside and runs without Metro.

**TestFlight**

1. App Store Connect › Apps › **+** › New App: iOS, name Beluga, the same bundle ID. One time only.
2. `npm run ios:testflight` (with `BELUGA_APPLE_TEAM_ID` set): archives a Release build, signs it for
   the App Store and uploads it. The build number is the time (`yymmddHHMM`) unless
   `BELUGA_IOS_BUILD_NUMBER` says otherwise, so every upload is new. It signs in with the Apple ID in
   Xcode › Settings › Accounts, or an App Store Connect API key (`BELUGA_ASC_KEY_PATH` to the .p8,
   `BELUGA_ASC_KEY_ID`, `BELUGA_ASC_ISSUER_ID`).
3. Once Apple has processed it (a few minutes), add yourself under TestFlight › Internal Testing and
   install it from the TestFlight app. Internal testers need no review.

`npm run ios:archive` stops before the upload: `dist/Beluga-<version>-<build>.xcarchive` and its
`.ipa`, which Xcode › Window › Organizer › Distribute App can upload too.

`ITSAppUsesNonExemptEncryption` is `false`: the link uses standard cryptography (Noise, libsodium)
only to protect your own data, which Apple's export rules exempt. It saves the question on every
upload; check it holds before a public App Store release.

**What's the same, what isn't**

| Android | iPhone |
| --- | --- |
| Pairing (QR, code, the four pictures), the link worklet over hyperdht | Same (BareKit, the same bundle) |
| Home, Work, conversations, Ask, Chats, People, tasks, plans, sentinels, dashboards, outputs, files, terminal | Same |
| Voice (Whisper on the phone) | Same |
| Saving a file into the phone's storage | The share sheet (Save Image, Save to Files) |
| Notifications while the app is open | Same |
| Stay connected (a foreground service keeps the link with the screen off) | Not possible: iOS suspends the app soon after it leaves the screen. Needs push (below) |
| Your Mac using this phone (Accessibility, screenshots, mirroring) | Not possible: iOS lets no app read or drive another |
| Board tiles on the Home screen | Not yet (would be a WidgetKit extension) |
| Updates itself from GitHub releases | TestFlight updates it |

Push (Beluga Push relay; `lib/notifications.ts` keeps the choices and makes the Android channels)
isn't on either platform yet. On iPhone it needs an APNs key (Certificates, Identifiers & Profiles
› Keys › Apple Push Notifications service) on the relay, a paid team, and the Push Notifications
entitlement back: `plugins/no-push-entitlement.js` takes it out for now, so a free team can sign.

**A free (personal) Apple team** signs the app for your own iPhone but not for TestFlight (that
needs the Apple Developer Program). The app it installs runs for 7 days, then wants a new build
from Xcode. The iPhone needs Developer Mode on (Settings › Privacy & Security), and the first
time, Settings › General › VPN & Device Management › trust your Apple ID.

## Not yet

Push (above), a release APK with the JS embedded.
