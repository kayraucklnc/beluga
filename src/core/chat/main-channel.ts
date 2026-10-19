import type { Mesh } from '../../net/mesh/mesh.js';

/**
 * Your main channel: one group with all your friends, so there's always a place to talk to
 * everyone at once. It's made the first time you open it (nobody gets a group they didn't
 * expect before that), and from then on every new friend is added to it. It's named after you
 * ("kay’s friends"): your friends see it among their channels next to their own.
 */
export class MainChannel {
  private syncing = false;

  constructor(
    private readonly mesh: Mesh,
    private readonly load: () => string | undefined,
    private readonly save: (groupId: string) => void,
  ) {}

  /** The main channel's group id, if it's here and you're still in it. */
  get id(): string | undefined {
    const id = this.load();
    return id && this.mesh.summary().groups.some((g) => g.id === id && g.active) ? id : undefined;
  }

  /** The main channel, made now if there isn't one (with all your friends in it). */
  ensure(): string {
    const known = this.id;
    if (known) {
      this.sync();
      return known;
    }
    const { self, friends } = this.mesh.summary();
    const name = `${self?.name ?? 'My'}’s friends`.slice(0, 64);
    const group = this.mesh.createGroup(name, friends.map((f) => f.peerId));
    this.save(group.id);
    return group.id;
  }

  /** Friends added since go in too (only an admin can add people: if you aren't one any more, it stays as it is). */
  sync(): void {
    const id = this.load();
    if (!id || this.syncing) return;
    const { friends, groups } = this.mesh.summary();
    const group = groups.find((g) => g.id === id);
    if (!group?.active || !group.admin) return;
    const missing = friends.filter((f) => !group.members.some((m) => m.peerId === f.peerId));
    if (!missing.length) return;
    this.syncing = true;
    try {
      for (const f of missing) this.mesh.addMember(id, f.peerId);
    } catch {
      // A friend removed meanwhile, or the group is full: the rest waits for the next change.
    } finally {
      this.syncing = false;
    }
  }
}
