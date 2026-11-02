import type { AgentRef, Profile } from '../protocol.js';

/**
 * The demo's friends run different agents, so screens show whose is whose: bob answers with
 * Claude (Opus) and also has Codex; mia answers with Codex and has a local model.
 */
const claudeOpus: AgentRef = { runtime: 'claude', model: 'opus', label: 'Claude' };
const codex: AgentRef = { runtime: 'codex', model: 'gpt-5', label: 'Codex' };
const local: AgentRef = { runtime: 'local', model: 'qwen3', label: 'Local' };

export const DEMO_AGENTS: Readonly<Record<'bob' | 'mia', Required<Pick<Profile, 'agents' | 'defaultAgent'>>>> = {
  bob: { agents: [claudeOpus, codex], defaultAgent: claudeOpus },
  mia: { agents: [codex, local], defaultAgent: codex },
};
