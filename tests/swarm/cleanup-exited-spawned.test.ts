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
  spawnSubagent,
  listSpawned,
  cleanupExitedSpawned,
  clearSpawnStateForTests,
  getAgentEventHistory,
} from '../../swarm/spawn.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal: NodeJS.Signals | number) => {
    // Simulate signal-based termination
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-spawn-test-'));
}

function cleanupTempDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

function getAgentEventsJsonlPath(cwd: string, sessionId: string): string {
  return path.join(cwd, '.pi', 'messenger', 'agents', `${sessionId}.jsonl`);
}

describe('cleanupExitedSpawned with event-sourced persistence', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    clearSpawnStateForTests();
  });

  it('persists completed agents via JSONL events', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-1';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test persistence',
        name: 'PersistBot',
      },
      sessionId
    );

    expect(listSpawned(cwd, sessionId)).toHaveLength(1);

    // Check event log has spawn event
    const jsonlPath = getAgentEventsJsonlPath(cwd, sessionId);
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const events = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(events).toHaveLength(1);
    const spawnEvent = JSON.parse(events[0]!);
    expect(spawnEvent.type).toBe('spawned');
    expect(spawnEvent.id).toBe(agent.id);

    // Simulate clean exit with code 0
    proc.exitCode = 0;
    proc.emit('close', 0);

    // Agent persisted as completed
    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('completed');
    expect(agents[0]?.endedAt).toBeDefined();

    // Check event log now has both events
    const updatedEvents = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(updatedEvents).toHaveLength(2);
    const completeEvent = JSON.parse(updatedEvents[1]!);
    expect(completeEvent.type).toBe('completed');

    cleanupTempDir(cwd);
  });

  it('persists agents killed by SIGTERM as stopped', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-2';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test signal persistence',
        name: 'SigtermBot',
      },
      sessionId
    );

    expect(listSpawned(cwd, sessionId)).toHaveLength(1);

    // Simulate SIGTERM termination
    proc.exitCode = null;
    proc.signalCode = 'SIGTERM';
    proc.emit('close', null, 'SIGTERM');

    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('stopped');

    cleanupTempDir(cwd);
  });

  it('persists failed agents', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-3';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test failure persistence',
        name: 'FailBot',
      },
      sessionId
    );

    // Simulate failure with non-zero exit
    proc.exitCode = 1;
    proc.signalCode = null;
    proc.emit('close', 1);

    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.status).toBe('failed');
    expect(agents[0]?.exitCode).toBe(1);

    cleanupTempDir(cwd);
  });

  it('returns 0 for cleanup when agents already persisted by close handler', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-4';

    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test count 1',
        name: 'CountBot1',
      },
      sessionId
    );

    spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test count 2',
        name: 'CountBot2',
      },
      sessionId
    );

    expect(listSpawned(cwd, sessionId)).toHaveLength(2);

    // Finalize both (close handler will persist them immediately)
    proc1.exitCode = 0;
    proc1.emit('close', 0);
    proc2.exitCode = 0;
    proc2.emit('close', 0);

    // close handler already persisted them, so cleanup returns 0
    vi.advanceTimersByTime(61_000);
    const finalized = cleanupExitedSpawned(cwd, sessionId);

    expect(finalized).toBe(0); // Already persisted by close handler
    // Both still persisted
    expect(listSpawned(cwd, sessionId)).toHaveLength(2);

    cleanupTempDir(cwd);
  });

  it('scopes agents by session ID in separate JSONL files', () => {
    const cwd = createTempCwd();
    const session1 = 'session-alpha';
    const session2 = 'session-beta';

    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();
    spawnMock.mockReturnValueOnce(proc1 as any).mockReturnValueOnce(proc2 as any);

    spawnSubagent(
      cwd,
      {
        role: 'Session Agent',
        objective: 'Test session 1',
        name: 'SessionBot1',
      },
      session1
    );

    spawnSubagent(
      cwd,
      {
        role: 'Session Agent',
        objective: 'Test session 2',
        name: 'SessionBot2',
      },
      session2
    );

    // Each session should only see its own agents
    expect(listSpawned(cwd, session1)).toHaveLength(1);
    expect(listSpawned(cwd, session2)).toHaveLength(1);
    expect(listSpawned(cwd, session1)[0]?.name).toBe('SessionBot1');
    expect(listSpawned(cwd, session2)[0]?.name).toBe('SessionBot2');

    // Verify separate JSONL files exist
    expect(fs.existsSync(getAgentEventsJsonlPath(cwd, session1))).toBe(true);
    expect(fs.existsSync(getAgentEventsJsonlPath(cwd, session2))).toBe(true);

    // Complete first agent
    proc1.exitCode = 0;
    proc1.emit('close', 0);
    vi.advanceTimersByTime(100);
    cleanupExitedSpawned(cwd, session1);

    // Session 1 sees completed agent, session 2 still has running agent
    expect(listSpawned(cwd, session1)[0]?.status).toBe('completed');
    expect(listSpawned(cwd, session2)[0]?.status).toBe('running');

    cleanupTempDir(cwd);
  });

  it('generates agent files for completed agents', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-files';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(
      cwd,
      {
        role: 'Documentation Writer',
        objective: 'Write docs',
        name: 'DocBot',
      },
      sessionId
    );

    // Complete the agent
    proc.exitCode = 0;
    proc.emit('close', 0);
    vi.advanceTimersByTime(100);
    cleanupExitedSpawned(cwd, sessionId);

    // Check that agent file was created
    const agentsDir = path.join(cwd, '.pi', 'messenger', 'agents', sessionId);
    expect(fs.existsSync(agentsDir)).toBe(true);

    const files = fs.readdirSync(agentsDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/DocBot-.*\.md$/);

    // Verify file content
    const content = fs.readFileSync(path.join(agentsDir, files[0]!), 'utf-8');
    expect(content).toContain('role: Documentation Writer');
    expect(content).toContain('---');

    cleanupTempDir(cwd);
  });

  it('reloads persisted agents from JSONL after clear', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-reload';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(
      cwd,
      {
        role: 'Test Agent',
        objective: 'Test reload',
        name: 'ReloadBot',
      },
      sessionId
    );

    // Complete and persist
    proc.exitCode = 0;
    proc.emit('close', 0);
    vi.advanceTimersByTime(100);
    cleanupExitedSpawned(cwd, sessionId);

    // Clear in-memory state
    clearSpawnStateForTests();

    // Should still be able to load from JSONL
    const agents = listSpawned(cwd, sessionId);
    expect(agents).toHaveLength(1);
    expect(agents[0]?.name).toBe('ReloadBot');
    expect(agents[0]?.status).toBe('completed');

    cleanupTempDir(cwd);
  });

  it('provides event history for audit trail', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-audit';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Audit Agent',
        objective: 'Test audit',
        name: 'AuditBot',
      },
      sessionId
    );

    // Complete the agent
    proc.exitCode = 0;
    proc.emit('close', 0);

    // Get full event history
    const history = getAgentEventHistory(cwd, sessionId, agent.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.type).toBe('spawned');
    expect(history[1]?.type).toBe('completed');

    cleanupTempDir(cwd);
  });
});
