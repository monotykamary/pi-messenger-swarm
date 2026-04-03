import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import * as store from '../store.js';

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-routing-'));
  roots.add(cwd);
  return cwd;
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  const inbox = path.join(base, 'inbox');
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(agentName: string, channel: string): MessengerState {
  return {
    agentName,
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: 'test-model',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    currentChannel: channel,
    sessionChannel: channel,
    joinedChannels: [channel, 'memory'],
  };
}

function writeRegistration(dirs: Dirs, registration: AgentRegistration): void {
  fs.writeFileSync(
    path.join(dirs.registry, `${registration.name}.json`),
    JSON.stringify(registration, null, 2)
  );
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('store channel routing', () => {
  it("defaults direct sends to the recipient's active session channel", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const sender = createState('Sender', 'session-sender');

    writeRegistration(dirs, {
      name: 'Peer',
      pid: process.pid,
      sessionId: 'peer-session',
      cwd,
      model: 'test-model',
      startedAt: new Date().toISOString(),
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
      currentChannel: 'session-peer',
      sessionChannel: 'session-peer',
      joinedChannels: ['session-peer', 'memory'],
    });

    const resolved = store.resolveTargetChannel(dirs, 'Peer');
    expect(resolved).toBe('session-peer');

    store.sendMessageToAgent(sender, dirs, 'Peer', 'hello', undefined, resolved!);
    const inboxFile = path.join(dirs.inbox, 'Peer', 'session-peer');
    expect(fs.existsSync(inboxFile)).toBe(true);
    expect(fs.readdirSync(inboxFile)).toHaveLength(1);
  });

  it('allows explicit named-channel delivery only when the recipient joined that channel', () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);

    writeRegistration(dirs, {
      name: 'Peer',
      pid: process.pid,
      sessionId: 'peer-session',
      cwd,
      model: 'test-model',
      startedAt: new Date().toISOString(),
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
      currentChannel: 'session-peer',
      sessionChannel: 'session-peer',
      joinedChannels: ['session-peer', 'memory'],
    });

    expect(store.resolveTargetChannel(dirs, 'Peer', 'memory')).toBe('memory');
    expect(store.resolveTargetChannel(dirs, 'Peer', 'architecture')).toBeNull();
  });
});
