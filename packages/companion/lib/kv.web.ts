/** lib/kv.ts for the browser (the demo on the web): localStorage. */
const PREFIX = 'beluga-companion:';
const store = (): Storage | undefined => (typeof localStorage === 'undefined' ? undefined : localStorage);

export const kv = {
  get<T>(key: string): T | undefined {
    try {
      const raw = store()?.getItem(PREFIX + key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch {
      return undefined;
    }
  },
  set(key: string, value: unknown): void {
    try {
      store()?.setItem(PREFIX + key, JSON.stringify(value));
    } catch (e) {
      // Quota: the cache is only a nicety.
      if (__DEV__) console.warn('[kv]', key, (e as Error).message);
    }
  },
  remove(key: string): void {
    store()?.removeItem(PREFIX + key);
  },
  clear(): void {
    const s = store();
    if (!s) return;
    for (const k of Object.keys(s)) if (k.startsWith(PREFIX)) s.removeItem(k);
  },
};
