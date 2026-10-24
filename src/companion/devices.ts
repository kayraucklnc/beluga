import { z } from 'zod';
import { readJson, writeJson } from '../net/mesh/files.js';
import { DeviceCert, type DeviceView, MAX_DEVICES } from './protocol.js';

/**
 * Your paired phones, kept in ~/.beluga/devices.json (0600): each one's certificate (public keys
 * and your identity's signature, nothing secret), when it was paired and last seen, its app's
 * version, and where to push to it. Removing a phone deletes its certificate: its key is refused
 * from then on (the host's firewall reads this book).
 */

export const DeviceRecord = z.object({
  cert: DeviceCert,
  pairedAt: z.number().int().min(0),
  lastSeen: z.number().int().min(0).optional(),
  app: z.string().max(40).optional(),
  push: z.object({ platform: z.enum(['fcm', 'apns']), token: z.string().max(4096), relayKey: z.string().max(200) }).optional(),
});
export type DeviceRecord = z.infer<typeof DeviceRecord>;

/** A device's id: the first 16 hex characters of its own key (stable, safe to show). */
export const deviceId = (cert: Pick<DeviceCert, 'device'>): string => cert.device.slice(0, 16);

export class DeviceBook {
  private list: readonly DeviceRecord[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    const raw = readJson(file);
    this.list = (Array.isArray(raw) ? raw : []).flatMap((r) => {
      const parsed = DeviceRecord.safeParse(r);
      return parsed.success ? [parsed.data] : [];
    });
  }

  all = (): readonly DeviceRecord[] => this.list;
  get size(): number {
    return this.list.length;
  }
  get = (id: string): DeviceRecord | undefined => this.list.find((r) => deviceId(r.cert) === id);
  /** The phone a Noise key belongs to (the firewall's question). */
  byLink = (linkHex: string): DeviceRecord | undefined => this.list.find((r) => r.cert.link === linkHex);

  /** Keep a new phone (the same device again replaces its old certificate). */
  add(cert: DeviceCert, app?: string): DeviceRecord {
    const rest = this.list.filter((r) => r.cert.device !== cert.device && r.cert.link !== cert.link);
    if (rest.length >= MAX_DEVICES) throw new Error(`You have ${MAX_DEVICES} phones paired; remove one first`);
    const record: DeviceRecord = { cert, pairedAt: cert.issuedAt, ...(app ? { app } : {}) };
    this.save([...rest, record]);
    return record;
  }

  remove(id: string): DeviceRecord | undefined {
    const gone = this.get(id);
    if (gone) this.save(this.list.filter((r) => r !== gone));
    return gone;
  }

  update(id: string, patch: Partial<Pick<DeviceRecord, 'lastSeen' | 'app' | 'push'>>): void {
    const current = this.get(id);
    if (!current) return;
    this.save(this.list.map((r) => (r === current ? { ...r, ...patch } : r)));
  }

  /** What the Mac's screens see (never keys): with who's linked right now. */
  views(linked: ReadonlySet<string>): DeviceView[] {
    return this.list.map((r) => ({
      id: deviceId(r.cert),
      name: r.cert.name,
      platform: r.cert.platform,
      ...(r.app ? { app: r.app } : {}),
      pairedAt: r.pairedAt,
      ...(r.lastSeen !== undefined ? { lastSeen: r.lastSeen } : {}),
      linked: linked.has(deviceId(r.cert)),
      push: Boolean(r.push),
    }));
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private save(next: readonly DeviceRecord[]): void {
    this.list = next;
    writeJson(this.file, next);
    for (const l of [...this.listeners]) l();
  }
}
