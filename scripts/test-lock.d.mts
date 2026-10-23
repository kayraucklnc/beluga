// Types for scripts/test-lock.mjs (used by vitest.config.ts and the tests).

export interface TestRun {
  readonly pid: number;
  /** Whose run, in words: "KLD-12". */
  readonly name: string;
  readonly worktree?: string;
  readonly startedAt: number;
}

export function slotsDir(): string;
export function slotCount(env?: Record<string, string | undefined>): number;
export function workerCount(env?: Record<string, string | undefined>, cores?: number): number;
export function trySlot(run: TestRun, opts?: { dir?: string; slots?: number }): { ok: true; file: string } | { ok: false; holders: TestRun[] };
export function releaseSlot(file: string, pid?: number): void;
export function waitingLine(holders: readonly TestRun[], slots: number): string;
export function waitForSlot(run: TestRun, opts?: { dir?: string; slots?: number; log?: (line: string) => void; pollMs?: number; maxMs?: number }): Promise<string | undefined>;
export default function setup(): Promise<(() => void) | undefined>;
