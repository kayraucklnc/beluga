import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never read or write the developer's real ~/.beluga (or an old ~/.klaud) during tests.
process.env.BELUGA_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-test-home-'));
// Nor the old name, for a test that clears BELUGA_HOME (an inherited KLAUD_HOME is real data).
delete process.env.KLAUD_HOME;
// Nor the developer's Codex sessions (deleting a worktree forgets the ones that ran there).
process.env.CODEX_HOME = mkdtempSync(path.join(os.tmpdir(), 'beluga-test-codex-'));
