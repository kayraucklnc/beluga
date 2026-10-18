import { z } from 'zod';

/**
 * The klaud network's part of the API (see api.ts): friends, direct messages, groups and your
 * status. Only the Mac app shows it; the calls fail with a clear message while the network is off.
 * Browser-safe: zod only.
 */

const peerId = z.string().regex(/^[\w-]{32}$/);
const groupId = z.string().regex(/^[0-9a-f]{32}$/);
const name = z.string().trim().min(1).max(64);
const text = z.string().min(1).max(8_000);
const invitation = z.string().min(1).max(500);
const page = z.object({ before: z.number().int().optional(), limit: z.number().int().min(1).max(500).optional() });
const conversation = z.string().regex(/^(dm:[\w-]{32}|group:[0-9a-f]{32})$/);
const Presence = z.object({ state: z.enum(['online', 'away', 'dnd', 'offline']), note: z.string().max(140).optional(), until: z.number().int().positive().optional() });

export const NETWORK_API = {
  // Whether the network is on, and your peer id and address on it.
  'network.status': { args: z.tuple([]) },
  'network.friends.list': { args: z.tuple([]) },
  // A one-time invitation: → { id, code, link, expiresAt }.
  'network.friends.invite': { args: z.tuple([]) },
  // Use a friend or group invitation (link or code): → who you're now friends with, or the group.
  'network.friends.accept': { args: z.tuple([invitation]) },
  'network.friends.cancelInvite': { args: z.tuple([z.string().regex(/^[0-9a-f]{16}$/)]) },
  'network.friends.remove': { args: z.tuple([peerId]) },
  'network.dm.send': { args: z.tuple([peerId, text]) },
  'network.dm.history': { args: z.tuple([peerId, page.optional()]) },
  'network.groups.list': { args: z.tuple([]) },
  'network.groups.create': { args: z.tuple([name, z.array(peerId).max(64).optional()]) },
  'network.groups.send': { args: z.tuple([groupId, text]) },
  'network.groups.history': { args: z.tuple([groupId, page.optional()]) },
  'network.groups.addMember': { args: z.tuple([groupId, peerId]) },
  'network.groups.removeMember': { args: z.tuple([groupId, peerId]) },
  'network.groups.setAdmin': { args: z.tuple([groupId, peerId, z.boolean()]) },
  'network.groups.leave': { args: z.tuple([groupId]) },
  'network.groups.rename': { args: z.tuple([groupId, name]) },
  // An invite link and code for a group (admins); `auto`: no approval needed.
  'network.groups.invite': { args: z.tuple([groupId, z.object({ auto: z.boolean().optional() }).optional()]) },
  'network.groups.join': { args: z.tuple([invitation]) },
  'network.groups.approve': { args: z.tuple([groupId, peerId]) },
  'network.groups.decline': { args: z.tuple([groupId, peerId]) },
  // `offline` means appear offline (you keep receiving).
  'network.presence.set': { args: z.tuple([Presence]) },
  'network.presence.get': { args: z.tuple([]) },
  // Mark a conversation read: `dm:<peerId>` or `group:<id>`.
  'network.read': { args: z.tuple([conversation]) },
} as const;
