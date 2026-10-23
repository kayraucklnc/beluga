# KLD-58: polish-round leftovers (PR #66)

Branch `klaud/kld-58-audit-fix-polish-round`, commits `6c68c46`, `5ea0d40`, `47834a5` (on Kayra's Mac).

## How it was audited
- **knip** (run from `/tmp`, nothing added to the repo) on both packages, with tests and e2e counted as entry points. Output is in `.klaud/scratch/knip-before.txt` and `knip-after.txt`.
- **Scoped to PR #66:** a hit counts only if `git blame` puts its line in one of the 69 plan commits (`2ab04f8^1..2ab04f8^2`). That left 36 of 417 unused exports, plus 0 of 84 unused types.
- **CSS:** a script checked each `.module.css` class added by the merge for a TSX reference, counting `styles[\`x_${tone}\`]` lookups as references.
- **Duplicates and half-wired code:** a read-only sweep of the merge diff for duplicated helpers, unused options, TODOs and events nobody listens to. No TODO/FIXME was added, and every new event has a listener.
- **Typecheck:** both packages pass; they didn't on the plan branch before this (see bugs 2 and 3).

## Bugs fixed
| # | Finding | Fix | Test |
|---|---|---|---|
| 1 | The sidebar footer used a stray `state.connection`, left behind when KLD-48's selectors were merged with KLD-52. It threw a ReferenceError whenever the room wasn't connected. | Its wording is now `footerStatus()` in `views/room/connection-model.ts`; the component selects a single boolean. | `tests/sidebar-footer.test.ts` |
| 2 | The Mac typecheck failed for the same reason. | Same fix. | Mac `tsc --noEmit` passes |
| 3 | The root typecheck failed: `connection-model.ts` imported core through `@klaud/`, which root tests can't resolve. | Relative import, matching the other models the root tests import. | Root `tsc --noEmit` passes |
| 4 | The PR sheet's `useNow` ticked every second while you weren't looking at the window, against KLD-40's "window stays cool" rule. | It uses `lib/window-active` `useClock`. | A guard in `tests/polish-leftovers.test.ts` lists every raw `setInterval` in the Mac UI |

## Duplicates merged
| Copies | Now | Test |
|---|---|---|
| `watchdog.elapsed` and `agent-host.span` ("45s / 12m / 2h 5m") | `src/shared/clock.ts` `span`. It rounds down: 90 s reads "1m", where agent-host showed "2m". | `tests/clock.test.ts`, plus updated steer tests |
| `watchdog.clock`, `run-failure.hhmm`, and older copies in claude-prompt, gateway/access and shared/quiet | `shared/clock.ts` `hhmm` | `tests/clock.test.ts`; the notifications, access and claude tests pass |
| `mergePrOnGitHub` and `mergePr` in `workspaces/pr.ts` | `mergePr`; the plan's PR merges with `{method:'merge'}` | `tests/pr-merge.test.ts`, new case |
| `READS_AFTER_STEP` copied into watchdog (it could drift silently) | `shared/claude-notices.ts`, used by both | `polish-leftovers` and watchdog tests now use the constant |
| Three copies of `conflicted` (git.ts ×2, sync.ts) and a second `tryGit` in sync.ts | `git.ts` `conflictedFiles` and `tryGit` | Real-git case in `polish-leftovers`; main-sync, combine and plan-branch tests pass |
| Three copies of `reducedMotion` (live-motion `still`, use-doc-theme, chat/flight) | `lib/reduced-motion.ts`; use-doc-theme re-exports it so FlowGraph (KLD-70's) stays untouched | `polish-leftovers` |
| Runner `toolOutput` re-implemented `resultText` | `shared/steps` `resultText` | `polish-leftovers` |
| `owner.planOfPlace` wrote out `planForHome` inline | `planForHome` | `polish-leftovers` |
| ProjectTree `ofPlan` was `isPlanOwned` | `isPlanOwned` | Mac typecheck |

## Dead code removed
- **35 exports added by #66 that only their own file uses** are no longer exported: watchdog ×13, progress ×3, pilot ×2, claude-process ×2, test-procs ×2, live-motion, plan-task-chats ×2, attention-model, chat-model, PlansNav, marks, mock, notify, run-failure.
- **`pathsInPaste` re-export** from `chat/paste-paths.ts`.
- **`.rowRing`** in `project-home.module.css`.
- **The New Plan sheet's `goal` prefill** (`lib/sheets.ts` → WorkSheets → NewPlanSheet): nothing ever opened the sheet with a goal, because Project Home creates the plan straight from the typed text.
- **Result:** knip found 36 merge-added unused exports before and 2 after; both are in KLD-70's file, below.

## Left alone, and why
- **Files other tasks own** (a note was left on KLD-70):
  - `plans/plans.module.css` classes `.modeChevron`, `.subRow`, `.nextLine` and most of `.gate*` (`.gateCheck` is still used)
  - `components/graph/sharp-zoom.ts` exports `SETTLE_MS` and `sharpen`
- **`test-procs.ts` `e2eLockFile`** copies `scripts/e2e-lock.mjs` `lockFile` on purpose: `dist/` can't import `scripts/`. KLD-57 is changing that lock, so the path must follow it.
- **`NEED_TIPS` / `NEED_WORDS`** (attention-model) word things differently on purpose: "A merge conflict to resolve" vs "<plan> has a merge conflict".
- **`ProjectTree` `planHomes`** also covers finished plans, which `planOf` doesn't.
- **`others.ts`'s inline `merge-base --is-ancestor`** passes its own 15 s timeout, which `isAncestor` doesn't take.
- **WaitingLine's `SendOrSteer` ignores `promote`'s result.** `false` only means the message already left the queue, and QueueTray ignores it silently too. Not a bug; it just has no "Steering…" state.
- **`src/ui/components/Header.tsx`** is an unused file from the TUI. It predates #66, and the TUI is frozen.
- **`.starting` in `chat/steps/steps.module.css`** looked orphaned, but it's next to KLD-72's files and wasn't verified.

## Follow-up tasks
- **KLD-76:** one window-aware clock hook. There are two `useClock`s plus about 6 local timers.
- **KLD-77:** share the composer suggestion list, textarea auto-grow and radio-arrow keys.
- **KLD-78:** merge the near-copy plan rows, PR chips, one-shot Claude helpers, paste and mention parsing, the checklist regex and pilot's conflict retry. Small extras that fit there: about 40 local `errorText`s and about 18 plural helpers with no shared one; `CONTINUE_PROMPT` exported from two modules with different text; `failureOf` written out in Items and PlanPage.
- **KLD-79:** wire or remove `mergePr` `deleteBranch` and `refreshPrs` reason `'push'`; neither has a caller in the UI.
