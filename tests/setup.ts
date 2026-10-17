import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Never read or write the developer's real ~/.klaud during tests.
process.env.KLAUD_HOME = mkdtempSync(path.join(os.tmpdir(), 'klaud-test-home-'));
