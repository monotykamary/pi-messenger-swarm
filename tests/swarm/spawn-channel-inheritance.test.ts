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

import { spawnSubagent, clearSpawnStateForTests } from '../../swarm/spawn.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-spawn-channel-'));
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

describe('swarm spawn channel inheritance', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('passes the parent channel to spawned agents via environment', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-channel';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(
      cwd,
      {
        role: 'Researcher',
        objective: 'Analyze regressions',
        name: 'ChildBot',
      },
      sessionId,
      'session-parent'
    );

    const env = spawnMock.mock.calls[0][2]?.env as Record<string, string>;
    expect(env.PI_MESSENGER_CHANNEL).toBe('session-parent');
    expect(env.PI_SWARM_SPAWNED).toBe('1');
  });
});
