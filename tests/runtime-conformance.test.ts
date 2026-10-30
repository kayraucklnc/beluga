import { createCodexRuntime } from '../src/agent/runtime/codex/index.js';
import { FakeCodex } from './fake-codex.js';
import { createFakeRuntime } from './fake-runtime.js';
import { runtimeConformance } from './runtime-conformance.js';

// The same suite for every runtime: the in-memory reference, and Codex over a scripted app-server.
runtimeConformance('fake', createFakeRuntime);
const codex = new FakeCodex();
runtimeConformance('codex', () => createCodexRuntime({ connect: codex.connect }));
