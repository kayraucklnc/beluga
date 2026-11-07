import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ScheduleSchema, type Schedule } from './schema.js';

/** Schedules on disk (~/.beluga/schedules.json). Without a folder they stay in memory: tests and the demo. */

const FILE = 'schedules.json';

export class ScheduleFile {
  constructor(private readonly dir: string | null) {}

  read(): Schedule[] {
    if (!this.dir) return [];
    let raw: { schedules?: unknown };
    try {
      raw = JSON.parse(readFileSync(path.join(this.dir, FILE), 'utf8')) as { schedules?: unknown };
    } catch {
      return [];
    }
    if (!Array.isArray(raw.schedules)) return [];
    return raw.schedules.flatMap((item) => {
      const parsed = ScheduleSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
  }

  write(schedules: readonly Schedule[]): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schedules })}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  }
}
