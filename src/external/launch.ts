import { existsSync } from 'node:fs';
import { runtimeStatuses } from '../agent/runtime/registry.js';
import type { Session } from '../core/session.js';
import type { LogItem } from '../core/store.js';
import { externalRequester } from '../core/trust.js';
import { asksEachStep, grantLookup } from './adapters/runs.js';
import { stopAgentWork } from './adapters/stop.js';
import { sessionControl } from './adapters/session-control.js';
import { sessionFiles } from './adapters/session-files.js';
import { sessionMethods } from './adapters/session-methods.js';
import type { ExternalToolDef } from './adapters/mcp-tools.js';
import { removeSemantic, semanticDir } from './adapters/semantic-fetch.js';
import { openSemantic, semanticSearch } from './adapters/semantic-search.js';
import { schemaOf, withDiscovery } from './adapters/tools/discover.js';
import { fileTools } from './adapters/tools/files.js';
import { peopleTools } from './adapters/tools/people.js';
import { ALL_METHOD_ROWS, methodTools } from './adapters/tools/method-rows.js';
import { sessionReads } from './adapters/session-reads.js';
import { controlTools } from './adapters/tools/control.js';
import { readTools } from './adapters/tools/read.js';
import { stateTools } from './adapters/tools/state.js';
import { peerTools } from './adapters/tools/peers.js';
import { workspaceTools } from './adapters/tools/workspace.js';
import { sessionState } from './adapters/session-state.js';
import { sessionPeers } from './adapters/session-peers.js';
import { sessionWorkspace } from './adapters/session-workspace.js';
import { experimentOn } from '../shared/experiments.js';
import { REMOTE_FULL_WARNING } from '../shared/remote-full.js';
import { LIMITS } from './domain/limits.js';
import { ALSO_LISTED, DISCOVERY_TOOLS } from './domain/tools.js';
import { attachExternal, attachToolSearch, detachExternal } from './registry.js';
import { ExternalService } from './service.js';

/** The external agents' server, in the daemon only. Listens only if you left it on. Returns its stop. */
export function launchExternal(deps: { readonly session: Session; readonly log?: (line: string) => void }): () => Promise<void> {
  const reads = sessionReads({
    state: () => deps.session.store.getState(),
    loadHistory: (id) => deps.session.workspaces?.manager.loadHistory<LogItem>(id) ?? [],
    stepsFor: (channel, itemId) => deps.session.host.stepsFor(channel, itemId),
    runtimes: async () => (await runtimeStatuses()).map((r) => ({ id: r.id, ready: r.state === 'ready', asksEachStep: asksEachStep(r.id), models: r.models.map((m) => ({ value: m.value, label: m.label })) })),
  });
  const chats = sessionControl(deps.session, { runCap: (id) => LIMITS[service.grants.list().find((g) => g.id === id)?.route ?? 'remote'].runs });
  const { listed, others } = externalTools({ reads, chats, methods: sessionMethods(deps.session), state: sessionState(deps.session), workspace: sessionWorkspace(deps.session), peers: sessionPeers(deps.session), files: sessionFiles(deps.session) });
  // Semantic tool search (Settings › Experimental): gets ready when it is turned on, and its files go when it is turned off.
  const semantic = semanticSearch({
    tools: () => others.map((def) => ({ name: def.name, description: def.description, inputSchema: schemaOf(def) })),
    on: () => experimentOn(deps.session.store.getState().prefs.experiments, 'toolSearch'),
    toast: (text, level) => deps.session.toast(text, level),
    open: (tools, onProgress) => openSemantic(tools, { onProgress }),
    fetched: () => existsSync(semanticDir()),
    remove: () => removeSemantic(),
  });
  semantic.follow();
  const unfollow = deps.session.store.subscribe(semantic.follow);
  attachToolSearch(deps.session, semantic.status);
  const service = new ExternalService({
    ...(deps.log ? { log: deps.log } : {}),
    tools: withDiscovery(listed, others, semantic.rank),
    // A card with no chat waits in the agent's own place, not in the group chat.
    // The agent is the card's peer: its cap on waiting cards applies and a stop finds them. The answer is only for this call, and writes no trust.
    ask: (title, detail, once, card, signal) => deps.session.host.ask('tool', title, detail, card ? externalRequester(card.agentId) : undefined, card?.chatId ? `ws:${card.chatId}` : card ? externalRequester(card.agentId) : 'room', { once, call: true, ...(card ? { asker: card.agent } : {}), ...(signal ? { signal } : {}) }),
    stopWork: (grantId) => stopAgentWork(deps.session, grantId),
    notify: (grant) => deps.session.toast(`${grant.name} connected to Beluga as an external agent (${grant.level})`, 'info'),
    notifyRemoteFull: (grant) => {
      const body = `${grant.name} at ${grant.redirectHost} has Full trust from outside this computer. ${REMOTE_FULL_WARNING} Revoke it in Settings › External agents if you didn't mean this.`;
      deps.session.toast(body, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: `${grant.name} has Full trust from outside this computer`, body });
    },
    notifyLockout: () => {
      const body = 'Too many wrong pairing codes came through a remote address, so new remote sign-ins stop for up to 10 minutes. Connected agents keep working. Wait, or close the route in Settings › External agents.';
      deps.session.toast(body, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: 'Remote sign-ins are stopped', body });
    },
    notifySuspended: (grant) => {
      deps.session.toast(`${grant.name} was suspended after repeated refusals. Resume or revoke it in Settings › External agents.`, 'error');
      deps.session.notifier.notify({ kind: 'problems', title: `${grant.name} was suspended`, body: 'It was refused again and again, so Beluga stopped it. Resume or revoke it in Settings › External agents.' });
    },
  });
  deps.session.host.setExternalAgents(grantLookup(service.grants, Date.now));
  attachExternal(deps.session, service);
  const starting = service.start();
  return async () => {
    unfollow();
    await starting;
    detachExternal(deps.session);
    await service.stop();
  };
}

export interface ToolPorts {
  readonly reads: Parameters<typeof readTools>[0];
  readonly chats: Parameters<typeof controlTools>[1] & { readonly startedBy: Parameters<typeof methodTools>[3] };
  readonly methods: Parameters<typeof methodTools>[2];
  readonly state: Parameters<typeof stateTools>[0];
  readonly workspace: Parameters<typeof workspaceTools>[1];
  readonly peers: Parameters<typeof peerTools>[0];
  readonly files: Parameters<typeof fileTools>[1];
}

/** What a client lists, and the others it reaches through beluga_find and beluga_call (bench/ratel builds the same). */
export function externalTools(p: ToolPorts): { readonly listed: ExternalToolDef[]; readonly others: ExternalToolDef[] } {
  const chatControl = controlTools(p.reads, p.chats);
  const all = [...stateTools(p.state, p.chats), ...workspaceTools(p.reads, p.workspace, p.chats), ...peerTools(p.peers), ...methodTools(ALL_METHOD_ROWS, p.reads, p.methods, p.chats.startedBy), ...fileTools(p.reads, p.files, p.methods), ...peopleTools(p.methods)];
  const alsoListed = all.filter((t) => (ALSO_LISTED as readonly string[]).includes(t.name));
  const others = all.filter((t) => !alsoListed.includes(t));
  return { listed: [...readTools(p.reads, { alsoTools: [...chatControl.map((t) => t.name), ...ALSO_LISTED, ...DISCOVERY_TOOLS], moreTools: others.length }), ...chatControl, ...alsoListed], others };
}
