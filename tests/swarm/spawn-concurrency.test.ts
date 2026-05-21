import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../swarm/progress.js', () => ({
  createProgress: () => ({
    tokens: 0,
    toolCallCount: 0,
    recentTools: [],
    status: 'running',
  }),
  parseJsonlLine: () => null,
  updateProgress: () => {},
}));

vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import { executeSpawn } from '../../swarm/handlers/spawn.js';
import { clearSpawnStateForTests } from '../../swarm/spawn.js';
import type { MessengerState } from '../../lib.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 80000 + Math.floor(Math.random() * 9999);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

function createTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-concurrency-test-'));
}

const roots = new Set<string>();

function tempCwd(): string {
  const cwd = createTempCwd();
  roots.add(cwd);
  return cwd;
}

const baseState: MessengerState = {
  agentName: 'TestOrchestrator',
  registered: true,
  reservations: [],
  chatHistory: new Map(),
  unreadCounts: new Map(),
  channelPostHistory: [],
  seenSenders: new Map(),
  model: '',
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
  contextSessionId: 'test-session',
  currentChannel: 'test',
  sessionChannel: 'test',
  joinedChannels: ['test'],
};

describe('spawn concurrency limit', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
    spawnMock.mockReset();
  });

  afterEach(() => {
    clearSpawnStateForTests();
    for (const root of roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    }
    roots.clear();
  });

  it('allows spawning when under the limit', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-under';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const result = executeSpawn(
      null,
      { objective: 'Test under limit' },
      baseState,
      cwd,
      sessionId,
      3 // limit
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('rejects spawn when at the concurrency limit', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-at';

    // Spawn 2 agents to fill the limit
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    executeSpawn(null, { objective: 'Agent 1' }, baseState, cwd, sessionId, 2);
    executeSpawn(null, { objective: 'Agent 2' }, baseState, cwd, sessionId, 2);

    // Third spawn should be rejected
    const result = executeSpawn(
      null,
      { objective: 'Agent 3' },
      baseState,
      cwd,
      sessionId,
      2 // limit
    );

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.running).toBe(2);
    expect(details.limit).toBe(2);
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('2 subagents already running');
  });

  it('allows spawn after an agent completes', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-complete';

    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    executeSpawn(null, { objective: 'Agent 1' }, baseState, cwd, sessionId, 2);
    executeSpawn(null, { objective: 'Agent 2' }, baseState, cwd, sessionId, 2);

    // Complete agent 1
    proc1.exitCode = 0;
    proc1.emit('close', 0);

    // Now there's room
    const proc3 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc3 as any);

    const result = executeSpawn(null, { objective: 'Agent 3' }, baseState, cwd, sessionId, 2);

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('uses default limit of 3 when maxConcurrentSpawns is not provided', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-default';

    // Spawn 3 agents to fill default limit
    for (let i = 0; i < 3; i++) {
      const proc = new FakeProcess();
      spawnMock.mockReturnValueOnce(proc as any);
      executeSpawn(null, { objective: `Agent ${i}` }, baseState, cwd, sessionId);
    }

    // Fourth should be rejected
    const result = executeSpawn(
      null,
      { objective: 'Agent 4' },
      baseState,
      cwd,
      sessionId
      // no maxConcurrentSpawns — uses default of 3
    );

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.limit).toBe(3);
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('3 subagents already running');
  });

  it('respects a custom limit of 1', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-1';

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    // First spawn succeeds
    executeSpawn(null, { objective: 'Only one' }, baseState, cwd, sessionId, 1);

    // Second spawn is rejected
    const result = executeSpawn(null, { objective: 'Too many' }, baseState, cwd, sessionId, 1);

    expect(result).toBeDefined();
    const details = (result as any).details ?? {};
    expect(details.error).toBe('concurrency_limit');
    expect(details.limit).toBe(1);
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('1 subagent already running');
  });

  it('non-create spawn operations bypass concurrency check', () => {
    const cwd = tempCwd();
    const sessionId = 'concurrency-list';

    const result = executeSpawn('list', {}, baseState, cwd, sessionId, 1);

    // list returns normally (no agents) — doesn't hit concurrency check
    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('No spawned agents');
  });
});
