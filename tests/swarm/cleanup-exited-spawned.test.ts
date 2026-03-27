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

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-cleanup-'));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
});

describe('cleanupExitedSpawned', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cleans up agents that exited with a code after 60 seconds', () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, {
      role: 'Test Agent',
      objective: 'Test cleanup',
      name: 'CodeExitBot',
    });

    expect(listSpawned(cwd)).toHaveLength(1);

    // Simulate clean exit with code 0
    proc.exitCode = 0;
    proc.signalCode = null;
    proc.emit('close', 0);

    // Should still be there immediately
    expect(listSpawned(cwd)).toHaveLength(1);

    // Should still be there before 60 seconds
    vi.advanceTimersByTime(59_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(1);

    // Should be cleaned up after 60 seconds
    vi.advanceTimersByTime(2_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(0);
  });

  it('cleans up agents killed by SIGTERM after 60 seconds', () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(cwd, {
      role: 'Test Agent',
      objective: 'Test signal cleanup',
      name: 'SigtermBot',
    });

    expect(listSpawned(cwd)).toHaveLength(1);

    // Simulate SIGTERM termination
    proc.exitCode = null;
    proc.signalCode = 'SIGTERM';
    proc.emit('close', null, 'SIGTERM');

    // Should still be there immediately
    expect(listSpawned(cwd)).toHaveLength(1);

    // Should still be there before 60 seconds
    vi.advanceTimersByTime(59_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(1);

    // Should be cleaned up after 60 seconds
    vi.advanceTimersByTime(2_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(0);
  });

  it('cleans up agents killed by SIGKILL after 60 seconds', () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, {
      role: 'Test Agent',
      objective: 'Test SIGKILL cleanup',
      name: 'SigkillBot',
    });

    expect(listSpawned(cwd)).toHaveLength(1);

    // Simulate SIGKILL termination
    proc.exitCode = null;
    proc.signalCode = 'SIGKILL';
    proc.emit('close', null, 'SIGKILL');

    // Should still be there immediately
    expect(listSpawned(cwd)).toHaveLength(1);

    // Should be cleaned up after 60 seconds
    vi.advanceTimersByTime(61_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(0);
  });

  it('does not clean up agents that are still running', () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, {
      role: 'Test Agent',
      objective: 'Test running preservation',
      name: 'RunningBot',
    });

    // Process is still running (exitCode is null, signalCode is null)
    expect(listSpawned(cwd)).toHaveLength(1);

    // Even after 60+ seconds, should not be cleaned up
    vi.advanceTimersByTime(61_000);
    cleanupExitedSpawned(cwd);
    expect(listSpawned(cwd)).toHaveLength(1);
  });

  it('returns count of removed agents', () => {
    const cwd = createTempCwd();
    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();

    spawnMock.mockReturnValueOnce(proc1 as any);
    spawnMock.mockReturnValueOnce(proc2 as any);

    spawnSubagent(cwd, { role: 'Test', objective: 'Test 1', name: 'Bot1' });
    spawnSubagent(cwd, { role: 'Test', objective: 'Test 2', name: 'Bot2' });

    // Both exit with code 0
    proc1.exitCode = 0;
    proc1.signalCode = null;
    proc1.emit('close', 0);

    proc2.exitCode = 0;
    proc2.signalCode = null;
    proc2.emit('close', 0);

    vi.advanceTimersByTime(61_000);
    const removed = cleanupExitedSpawned(cwd);

    expect(removed).toBe(2);
    expect(listSpawned(cwd)).toHaveLength(0);
  });

  it('respects cwd filter when cleaning up', () => {
    const cwd1 = createTempCwd();
    const cwd2 = createTempCwd();

    const proc1 = new FakeProcess();
    const proc2 = new FakeProcess();

    spawnMock.mockReturnValueOnce(proc1 as any);
    spawnMock.mockReturnValueOnce(proc2 as any);

    spawnSubagent(cwd1, { role: 'Test', objective: 'Test cwd1', name: 'Cwd1Bot' });
    spawnSubagent(cwd2, { role: 'Test', objective: 'Test cwd2', name: 'Cwd2Bot' });

    // Both exit
    proc1.exitCode = 0;
    proc1.signalCode = null;
    proc1.emit('close', 0);

    proc2.exitCode = null;
    proc2.signalCode = 'SIGTERM';
    proc2.emit('close', null, 'SIGTERM');

    vi.advanceTimersByTime(61_000);

    // Only clean up cwd1
    cleanupExitedSpawned(cwd1);

    expect(listSpawned(cwd1)).toHaveLength(0);
    expect(listSpawned(cwd2)).toHaveLength(1);
  });
});
