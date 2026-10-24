# Beluga

The engine (`src/`, the daemon) and its two screens: the Mac app (`packages/mac`) and the phone
companion (`packages/companion`). Both screens drive the same core through `src/ipc/api.ts`.
How it fits together: `docs/how-it-works.md`.

## Keep the phone in step with the Mac

The Mac app moves fast; the phone must never fall behind silently. Whenever you change the
daemon or the Mac app, check the phone too, in the same change:

- **A new or changed API method** (`src/ipc/*-api.ts`): classify it in `src/companion/coverage.ts`
  as `phone` or `mac` (the typecheck fails until you do). `phone` only for what fits the phone:
  reading, answering, asking, chatting. Never code, diffs, git, terminals or settings.
- **A change to what a screen shows** (conversations, sub-agents, outputs, plans, approvals,
  questions, friends' requests, chats, usage): update its view in `src/companion/views.ts`, and the
  phone screen that draws it in `packages/companion/app/`. Run `npx vitest run tests/companion-*`.
- **Something new that waits for the user** (a new kind of approval, question or decision): it
  must reach the phone as a `NeedsYou` item with its actions, and notify. A phone that doesn't know
  the kind shows a plain card, so add it to the phone's cards too.
- **The link's frames or the views' shape** (`src/companion/protocol.ts`): additive changes only
  within `COMPANION_PROTO.major`. A breaking change bumps the major, keeps the old one answered for a
  release, and is written up in `docs/companion.md`.
- Nothing that is source code goes to the phone: files only through `isArtifact` and never
  `isSecretPath` (`src/companion/files.ts`), text through `stripCode`.
- The phone's look (`packages/companion/lib/theme.ts`): soft pastels and icons, never glows or
  neon. Headers and toolbars are solid with a hairline once scrolled, never a gradient fade. One main action on the surface; advanced options go behind the ••• / long-press sheet or
  Settings › Advanced, never as extra buttons.

## Also kept in step

- `docs/parity.md` lists every command, UI action, menu and API method with where the Mac shows it
  (`tests/parity.test.ts`).
- The core stays free of UI code (`tests/boundaries.test.ts`); what the screens import stays
  browser-safe (`tests/browser-safe.test.ts`), and `src/companion/protocol.ts` too: zod only.

## Checks

`npm run typecheck`, `npx vitest run`, and in `packages/companion`: `npm run typecheck`.
