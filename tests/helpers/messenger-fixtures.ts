import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentRegistration, Dirs, MessengerState } from '../../lib.js';

const roots = new Set<string>();

export interface MessengerFixture {
  cwd: string;
  dirs: Dirs;
}

export function createMessengerFixture(prefix = 'pi-messenger-fixture-'): MessengerFixture {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.add(cwd);

  const base = path.join(cwd, '.pi', 'messenger');
  const dirs: Dirs = {
    base,
    registry: path.join(base, 'registry'),
    inbox: path.join(base, 'inbox'),
  };

  fs.mkdirSync(dirs.registry, { recursive: true });
  fs.mkdirSync(dirs.inbox, { recursive: true });

  return { cwd, dirs };
}

export function createState(
  agentName = 'AgentA',
  overrides: Partial<MessengerState> = {}
): MessengerState {
  return {
    agentName,
    registered: false,
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
    contextSessionId: undefined,
    currentChannel: 'general',
    sessionChannel: 'general',
    joinedChannels: ['general', 'memory'],
    ...overrides,
  };
}

export function createContext(
  cwd: string,
  sessionId = 'test-session-1',
  hasUI = false
): ExtensionContext {
  return {
    hasUI,
    cwd,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setStatus: () => {},
      custom: async () => undefined,
    } as ExtensionContext['ui'],
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => sessionId,
    } as ExtensionContext['sessionManager'],
    model: { id: 'test-model' },
  } as unknown as ExtensionContext;
}

export function writeRegistration(
  dirs: Dirs,
  registration: Partial<AgentRegistration> & Pick<AgentRegistration, 'name'>
): AgentRegistration {
  const record: AgentRegistration = {
    name: registration.name,
    pid: registration.pid ?? process.pid,
    sessionId: registration.sessionId ?? 'test-session-1',
    cwd: registration.cwd ?? process.cwd(),
    model: registration.model ?? 'test-model',
    startedAt: registration.startedAt ?? new Date().toISOString(),
    reservations: registration.reservations,
    gitBranch: registration.gitBranch,
    spec: registration.spec,
    isHuman: registration.isHuman ?? false,
    session: registration.session ?? { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: registration.activity ?? { lastActivityAt: new Date().toISOString() },
    statusMessage: registration.statusMessage,
    currentChannel: registration.currentChannel,
    sessionChannel: registration.sessionChannel,
    joinedChannels: registration.joinedChannels,
  };

  fs.mkdirSync(dirs.registry, { recursive: true });
  fs.writeFileSync(
    path.join(dirs.registry, `${record.name}.json`),
    JSON.stringify(record, null, 2)
  );
  return record;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures in tests
    }
  }
  roots.clear();
});
