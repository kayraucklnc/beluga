import { File, Paths } from 'expo-file-system';

/**
 * A small key-value file for what the phone keeps between launches that isn't secret: the last
 * views (so "your Mac is asleep" still shows them, "as of 10:42"), the outbox, the phone's
 * notification settings. Secrets (the pairing, the device key) live in lib/secure.ts.
 */
const file = (): File => new File(Paths.document, 'beluga-companion.json');
let memo: Record<string, unknown> | undefined;

function all(): Record<string, unknown> {
  if (memo) return memo;
  try {
    const f = file();
    memo = f.exists ? (JSON.parse(f.textSync()) as Record<string, unknown>) : {};
  } catch {
    memo = {};
  }
  return memo;
}

let timer: ReturnType<typeof setTimeout> | undefined;
function flush(): void {
  if (timer) return;
  // Coalesced: views change often while you look; the disk needn't hear about each.
  timer = setTimeout(() => {
    timer = undefined;
    try {
      const f = file();
      if (!f.exists) f.create();
      void f.write(JSON.stringify(memo ?? {}));
    } catch {
      // A full disk loses the cache, nothing else.
    }
  }, 1500);
}

export const kv = {
  get<T>(key: string): T | undefined {
    return all()[key] as T | undefined;
  },
  set(key: string, value: unknown): void {
    all()[key] = value;
    flush();
  },
  remove(key: string): void {
    delete all()[key];
    flush();
  },
  clear(): void {
    memo = {};
    flush();
  },
};
