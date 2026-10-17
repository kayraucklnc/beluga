import { z } from 'zod';

/** Wire protocol version. Bump on breaking changes. */
export const PROTOCOL_VERSION = 1;

export const MAX_TEXT = 64_000;
export const MAX_FILE_BYTES = 512 * 1024;
/** Downloads are sent in chunks small enough to fit comfortably in one frame. */
export const CHUNK_BYTES = 256 * 1024;
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const shortStr = z.string().min(1).max(256);
const relPath = z.string().max(4096);

export const ShareInfo = z.object({
  name: z.string().regex(/^[\w.-]{1,64}$/),
  writable: z.boolean(),
});
export type ShareInfo = z.infer<typeof ShareInfo>;

export const UsageWindow = z.object({
  /** Percent of the window used, 0-100. */
  pct: z.number().min(0).max(100),
  /** Epoch ms when the window resets. */
  resetsAt: z.number().optional(),
});

/** Claude plan usage, shared so friends can see whose Claude has room left. */
export const Usage = z.object({
  plan: z.string().max(32).optional(),
  fiveHour: UsageWindow.optional(),
  week: UsageWindow.optional(),
  updatedAt: z.number(),
});
export type Usage = z.infer<typeof Usage>;

export const Profile = z.object({
  name: z.string().regex(/^[\w.-]{1,32}$/),
  shares: z.array(ShareInfo).max(32),
  agent: z.boolean(),
  usage: Usage.optional(),
});
export type Profile = z.infer<typeof Profile>;

export const PeerInfo = Profile.extend({ peerId: shortStr });
export type PeerInfo = z.infer<typeof PeerInfo>;

// ---------------------------------------------------------------------------
// Application bodies (always end-to-end encrypted inside a frame "box")
// ---------------------------------------------------------------------------

export const ChatBody = z.object({
  kind: z.literal('chat'),
  text: z.string().min(1).max(MAX_TEXT),
  byAgent: z.boolean().default(false),
});

export const FocusBody = z.object({
  kind: z.literal('focus'),
  owner: shortStr,
  share: shortStr,
  path: relPath,
  actor: z.enum(['human', 'agent']),
});

export const AgentRequestBody = z.object({
  kind: z.literal('agent_request'),
  requestId: shortStr,
  prompt: z.string().min(1).max(MAX_TEXT),
  viaAgent: z.boolean().default(false),
});

export const AgentEventKind = z.enum([
  'awaiting_approval',
  'started',
  'text',
  'tool',
  'done',
  'error',
  'denied',
]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

export const AgentEventBody = z.object({
  kind: z.literal('agent_event'),
  requestId: shortStr,
  requester: shortStr,
  event: AgentEventKind,
  text: z.string().max(MAX_TEXT).default(''),
});

export const FsListBody = z.object({
  kind: z.literal('fs_list'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
});

export const FsEntry = z.object({ name: z.string(), dir: z.boolean(), size: z.number() });
export type FsEntry = z.infer<typeof FsEntry>;

export const FsListResultBody = z.object({
  kind: z.literal('fs_list_result'),
  reqId: shortStr,
  ok: z.boolean(),
  entries: z.array(FsEntry).max(5000).optional(),
  error: z.string().optional(),
});

export const FsReadBody = z.object({
  kind: z.literal('fs_read'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
});

export const FsReadResultBody = z.object({
  kind: z.literal('fs_read_result'),
  reqId: shortStr,
  ok: z.boolean(),
  content: z.string().max(MAX_FILE_BYTES).optional(),
  truncated: z.boolean().optional(),
  error: z.string().optional(),
});

export const FsChangedBody = z.object({
  kind: z.literal('fs_changed'),
  share: shortStr,
  path: relPath,
});

export const FsFetchBody = z.object({
  kind: z.literal('fs_fetch'),
  reqId: shortStr,
  share: shortStr,
  path: relPath,
  offset: z.number().int().min(0),
});

export const FsChunkBody = z.object({
  kind: z.literal('fs_chunk'),
  reqId: shortStr,
  ok: z.boolean(),
  /** base64 bytes */
  data: z.string().max(Math.ceil((CHUNK_BYTES * 4) / 3) + 8).optional(),
  offset: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  error: z.string().optional(),
});

export const ReportBody = z.object({
  kind: z.literal('report'),
  share: shortStr,
  path: relPath,
  title: z.string().max(200),
});

export const Body = z.discriminatedUnion('kind', [
  ChatBody,
  FocusBody,
  AgentRequestBody,
  AgentEventBody,
  FsListBody,
  FsListResultBody,
  FsReadBody,
  FsReadResultBody,
  FsChangedBody,
  FsFetchBody,
  FsChunkBody,
  ReportBody,
]);
export type Body = z.infer<typeof Body>;
export type BodyOf<K extends Body['kind']> = Extract<Body, { kind: K }>;
/** Input shape for sending: fields with defaults are optional. */
export type BodyInput = z.input<typeof Body>;

// ---------------------------------------------------------------------------
// Frames (what actually travels over the websocket)
// ---------------------------------------------------------------------------

export const Box = z.object({ iv: z.string(), ct: z.string(), tag: z.string() });
export type Box = z.infer<typeof Box>;

export const ChallengeFrame = z.object({ t: z.literal('challenge'), v: z.number(), nonce: z.string() });
export const HelloFrame = z.object({
  t: z.literal('hello'),
  peerId: shortStr,
  proof: z.string(),
  box: Box,
});
export const WelcomeFrame = z.object({
  t: z.literal('welcome'),
  you: PeerInfo,
  box: Box,
});
export const PeersFrame = z.object({ t: z.literal('peers'), box: Box });
export const MsgFrame = z.object({
  t: z.literal('msg'),
  from: shortStr.optional(),
  to: shortStr.optional(),
  keep: z.boolean().optional(),
  ts: z.number().optional(),
  box: Box,
});
export type MsgFrame = z.infer<typeof MsgFrame>;
export const ErrorFrame = z.object({ t: z.literal('error'), message: z.string() });

export const Frame = z.discriminatedUnion('t', [
  ChallengeFrame,
  HelloFrame,
  WelcomeFrame,
  PeersFrame,
  MsgFrame,
  ErrorFrame,
]);
export type Frame = z.infer<typeof Frame>;

export const WelcomePayload = z.object({
  room: z.string().max(64).optional(),
  peers: z.array(PeerInfo),
  history: z.array(MsgFrame),
});

/** Parse untrusted JSON text into a frame, returning null if malformed. */
export function parseFrame(raw: string): Frame | null {
  try {
    const result = Frame.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
