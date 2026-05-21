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

import {
  reconcileSpawnedAgents,
  listSpawned,
  listSpawnedHistory,
  spawnSubagent,
  clearSpawnStateForTests,
} from '../../swarm/spawn.js';
import type { SpawnedAgent } from '../../swarm/types.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 90000 + Math.floor(Math.random() * 9999);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals | number) => {
    if (signal === 'SIGTERM' || signal === 'SIGKILL') {
      this.signalCode = signal as NodeJS.Signals;
      this.exitCode = null;
      setTimeout(() => {
        this.emit('close', null, this.signalCode);
      }, 10);
    }
    return true;
  });
}

function createTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-reconcile-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function getAgentEventsJsonlPath(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'agents', `${safeSessionId}.jsonl`);
}

function appendRawEvent(cwd: string, sessionId: string, event: unknown): void {
  const filePath = getAgentEventsJsonlPath(cwd, sessionId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

const roots = new Set<string>();

function tempCwd(): string {
  const cwd = createTempCwd();
  roots.add(cwd);
  return cwd;
}

describe('reconcileSpawnedAgents', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
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

  it('marks a running agent as failed when its PID is dead', () => {
    // Use a PID that definitely doesn't exist (max PID + 1)
    const deadPid = 4194304;
    const cwd = tempCwd();
    const sessionId = 'reconcile-pid-dead';
    const startedAt = new Date().toISOString();

    appendRawEvent(cwd, sessionId, {
      id: 'agent-dead',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-dead',
        cwd,
        name: 'DeadAgent',
        role: 'Worker',
        objective: 'Die silently',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-dead',
      type: 'progress',
      timestamp: startedAt,
      agent: { pid: deadPid },
    });

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(1);

    const agents = listSpawnedHistory(cwd, sessionId);
    expect(agents[0]?.status).toBe('failed');
    expect(agents[0]?.error).toContain('PID liveness check');
    expect(agents[0]?.endedAt).toBeDefined();
  });

  it('does not touch agents with live PIDs', () => {
    // Use the current process PID, which is definitely alive
    const livePid = process.pid;
    const cwd = tempCwd();
    const sessionId = 'reconcile-pid-alive';
    const startedAt = new Date().toISOString();

    appendRawEvent(cwd, sessionId, {
      id: 'agent-alive',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-alive',
        cwd,
        name: 'AliveAgent',
        role: 'Worker',
        objective: 'Still kicking',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-alive',
      type: 'progress',
      timestamp: startedAt,
      agent: { pid: livePid },
    });

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(0);

    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('running');
  });

  it('marks stale agents without PIDs as failed', () => {
    const cwd = tempCwd();
    const sessionId = 'reconcile-stale';
    // Agent started 3 hours ago (exceeds the 2-hour threshold)
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

    appendRawEvent(cwd, sessionId, {
      id: 'agent-stale',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-stale',
        cwd,
        name: 'StaleAgent',
        role: 'Worker',
        objective: 'Old and stale',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    // No PID progress event — simulates agents from before the pid field was added

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(1);

    const agents = listSpawnedHistory(cwd, sessionId);
    expect(agents[0]?.status).toBe('failed');
    expect(agents[0]?.error).toContain('staleness threshold');
  });

  it('leaves recent agents without PIDs alone', () => {
    const cwd = tempCwd();
    const sessionId = 'reconcile-recent';
    const startedAt = new Date().toISOString();

    appendRawEvent(cwd, sessionId, {
      id: 'agent-recent',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-recent',
        cwd,
        name: 'RecentAgent',
        role: 'Worker',
        objective: 'Still young',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(0);

    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('running');
  });

  it('skips agents that already have a terminal status', () => {
    const cwd = tempCwd();
    const sessionId = 'reconcile-terminal';
    const startedAt = new Date().toISOString();

    appendRawEvent(cwd, sessionId, {
      id: 'agent-done',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-done',
        cwd,
        name: 'DoneAgent',
        role: 'Worker',
        objective: 'Already done',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-done',
      type: 'completed',
      timestamp: new Date().toISOString(),
      agent: {
        status: 'completed',
        endedAt: new Date().toISOString(),
        exitCode: 0,
      },
    });

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(0);
  });

  it('reconciles multiple dead agents in one pass', () => {
    const deadPid1 = 4194304;
    const deadPid2 = 4194305;
    const cwd = tempCwd();
    const sessionId = 'reconcile-multi';
    const startedAt = new Date().toISOString();

    // First dead agent with PID
    appendRawEvent(cwd, sessionId, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'Dead1',
        role: 'Worker',
        objective: 'First dead',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-1',
      type: 'progress',
      timestamp: startedAt,
      agent: { pid: deadPid1 },
    });

    // Second dead agent with PID
    appendRawEvent(cwd, sessionId, {
      id: 'agent-2',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-2',
        cwd,
        name: 'Dead2',
        role: 'Worker',
        objective: 'Second dead',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-2',
      type: 'progress',
      timestamp: startedAt,
      agent: { pid: deadPid2 },
    });

    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(2);

    const agents = listSpawnedHistory(cwd, sessionId);
    expect(agents.every((a) => a.status === 'failed')).toBe(true);
  });

  it('detects dead agents after harness restart (in-memory runtimes lost)', () => {
    const cwd = tempCwd();
    const sessionId = 'reconcile-harness-restart';
    const deadPid = 4194304;
    const startedAt = new Date().toISOString();

    // Simulate what's on disk after a harness restart: the spawned + pid events
    // exist in JSONL, but the in-memory runtimes map is empty.
    appendRawEvent(cwd, sessionId, {
      id: 'agent-orphan',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-orphan',
        cwd,
        name: 'OrphanAgent',
        role: 'Worker',
        objective: 'Lost in restart',
        status: 'running',
        startedAt,
        sessionId,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, sessionId, {
      id: 'agent-orphan',
      type: 'progress',
      timestamp: startedAt,
      agent: { pid: deadPid },
    });

    // In-memory runtimes are empty (simulating harness restart)
    // listSpawned reads from JSONL and finds "running" agent
    expect(listSpawned(cwd, sessionId)).toHaveLength(1);
    expect(listSpawned(cwd, sessionId)[0]?.status).toBe('running');

    // reconcile catches the dead PID
    const reconciled = reconcileSpawnedAgents(cwd, sessionId);
    expect(reconciled).toBe(1);

    // Now it's correctly marked as failed
    expect(listSpawned(cwd, sessionId)).toHaveLength(0); // no running agents
    const all = listSpawnedHistory(cwd, sessionId);
    expect(all[0]?.status).toBe('failed');
  });
});
