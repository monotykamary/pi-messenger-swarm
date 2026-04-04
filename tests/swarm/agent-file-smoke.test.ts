import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { executeSpawn } from '../../swarm/handlers.js';
import type { MessengerState } from '../../lib.js';
import { clearSpawnStateForTests } from '../../swarm/spawn.js';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

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

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-smoke-'));
  roots.add(cwd);
  return cwd;
}

function createState(agentName: string): MessengerState {
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
    gitBranch: 'main',
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    currentChannel: 'test-channel',
    sessionChannel: 'test-channel',
    joinedChannels: ['test-channel'],
  } as MessengerState;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
  spawnMock.mockClear();
});

describe('agent file smoke tests', () => {
  it('spawns from agent file via handler', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-smoke-1';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agentFile = path.join(cwd, 'test-agent.md');
    fs.writeFileSync(agentFile, 'System prompt from file', 'utf-8');

    const state = createState('TestAgent');
    const result = executeSpawn(
      null,
      {
        agentFile: './test-agent.md',
        message: 'Do the mission',
      },
      state,
      cwd,
      sessionId
    );

    expect(result.details?.mode).toBe('spawn');
    expect(result.content[0]?.text).toContain('Spawned');

    // Verify file was used as system prompt
    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--append-system-prompt');
    const promptPath = args[idx + 1];
    expect(fs.readFileSync(promptPath, 'utf-8')).toBe('System prompt from file');

    // Verify message was user prompt
    expect(args[args.length - 1]).toBe('Do the mission');

    proc.emit('close', 0);
  });

  it('returns error when agent file not found', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-smoke-2';
    const state = createState('TestAgent');

    const result = executeSpawn(
      null,
      {
        agentFile: './nonexistent.md',
        message: 'Do something',
      },
      state,
      cwd,
      sessionId
    );

    expect(result.details?.mode).toBe('spawn');
    expect(result.details?.error).toBeDefined();
    expect(result.content[0]?.text).toContain('Error');
  });

  it('spawns with agentFile using objective from file when message not provided', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-smoke-3';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const state = createState('TestAgent');

    const agentFile = path.join(cwd, 'agent.md');
    fs.writeFileSync(
      agentFile,
      '---\nrole: FileRole\nobjective: Objective from file\n---\n\nSystem prompt content',
      'utf-8'
    );

    const result = executeSpawn(
      null,
      {
        agentFile: './agent.md',
        // No message - should use objective from file
      },
      state,
      cwd,
      sessionId
    );

    expect(result.details?.mode).toBe('spawn');
    expect(result.details?.error).toBeUndefined();
    expect(result.content[0]?.text).toContain('Spawned');
  });

  it('traditional autoregressive spawn still works', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-smoke-4';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const state = createState('TestAgent');
    const result = executeSpawn(
      null,
      {
        role: 'Custom Role',
        message: 'Do custom work',
      },
      state,
      cwd,
      sessionId
    );

    expect(result.details?.mode).toBe('spawn');
    expect(result.content[0]?.text).toContain('Spawned');
    expect(result.details?.agent?.role).toBe('Custom Role');

    proc.emit('close', 0);
  });
});
