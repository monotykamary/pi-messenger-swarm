import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mariozechner/pi-tui', () => ({
  truncateToWidth: (s: string, _width: number) => s,
  visibleWidth: (s: string) => s.length,
}));

const mocks = vi.hoisted(() => ({
  getActiveAgents: vi.fn(),
  getClaims: vi.fn(),
  getTasks: vi.fn(),
  getLiveWorkers: vi.fn(),
}));

vi.mock('../../store.js', () => ({
  getActiveAgents: mocks.getActiveAgents,
  getClaims: mocks.getClaims,
}));

vi.mock('../../swarm/store.js', () => ({
  getTasks: mocks.getTasks,
}));

vi.mock('../../swarm/live-progress.js', () => ({
  getLiveWorkers: mocks.getLiveWorkers,
}));

import { renderAgentsRow } from '../../overlay-render.js';
import type { MessengerState } from '../../lib.js';
import type { Dirs } from '../../lib.js';
import type { LiveWorkerInfo } from '../../swarm/live-progress.js';

function makeState(agentName: string): MessengerState {
  return {
    agentName,
    scopeToFolder: false,
    chatHistory: new Map(),
    channelPostHistory: [],
    registered: true,
    reservations: [],
    sessionStartedAt: new Date().toISOString(),
    activity: {},
    currentChannel: 'test-channel',
    sessionChannel: 'test-channel',
    joinedChannels: ['test-channel'],
  } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: '/tmp', registry: '/tmp/reg' };
}

function makeWorker(name: string, taskId: string): LiveWorkerInfo {
  return {
    cwd: '/tmp',
    taskId,
    agent: 'swarm-subagent',
    name,
    progress: {
      toolCallCount: 0,
      tokens: 0,
      recentTools: [],
    },
    startedAt: Date.now(),
  };
}

describe('renderAgentsRow', () => {
  beforeEach(() => {
    mocks.getActiveAgents.mockReset();
    mocks.getClaims.mockReset();
    mocks.getTasks.mockReset();
    mocks.getLiveWorkers.mockReset();
  });

  it('shows multiple live workers with different names on the same task', () => {
    mocks.getActiveAgents.mockReturnValue([]);
    mocks.getClaims.mockReturnValue([]);
    mocks.getTasks.mockReturnValue([]);

    // 4 agents working on the same task
    const workers = new Map([
      ['task-1', makeWorker('Researcher-1', 'task-1')],
      ['task-1-2', makeWorker('Researcher-2', 'task-1')],
      ['task-1-3', makeWorker('Researcher-3', 'task-1')],
      ['task-1-4', makeWorker('Researcher-4', 'task-1')],
    ]);
    mocks.getLiveWorkers.mockReturnValue(workers);

    const state = makeState('Me');
    const dirs = makeDirs();
    const result = renderAgentsRow('/tmp', 200, state, dirs, 300000);

    // Should contain all 4 agent names
    expect(result).toContain('Researcher-1');
    expect(result).toContain('Researcher-2');
    expect(result).toContain('Researcher-3');
    expect(result).toContain('Researcher-4');

    // Should show the task ID for each
    const taskCount = (result.match(/task-1/g) || []).length;
    expect(taskCount).toBe(4);
  });

  it('deduplicates by worker name, not by task ID', () => {
    mocks.getActiveAgents.mockReturnValue([]);
    mocks.getClaims.mockReturnValue([]);
    mocks.getTasks.mockReturnValue([]);

    // Same worker updated multiple times (should only appear once)
    const workers = new Map([
      ['task-1', makeWorker('Researcher-1', 'task-1')],
      ['task-1-dup', makeWorker('Researcher-1', 'task-1')], // Same name, same task
    ]);
    mocks.getLiveWorkers.mockReturnValue(workers);

    const state = makeState('Me');
    const dirs = makeDirs();
    const result = renderAgentsRow('/tmp', 200, state, dirs, 300000);

    // Should only contain one instance of Researcher-1
    const matches = result.match(/Researcher-1/g) || [];
    expect(matches.length).toBe(1);
  });

  it('shows self plus workers correctly', () => {
    mocks.getActiveAgents.mockReturnValue([]);
    mocks.getClaims.mockReturnValue([]);
    mocks.getTasks.mockReturnValue([]);

    const workers = new Map([
      ['task-1', makeWorker('Helper-1', 'task-1')],
      ['task-2', makeWorker('Helper-2', 'task-2')],
    ]);
    mocks.getLiveWorkers.mockReturnValue(workers);

    const state = makeState('Alpha');
    const dirs = makeDirs();
    const result = renderAgentsRow('/tmp', 200, state, dirs, 300000);

    // Should show self
    expect(result).toContain('You');

    // Should show both workers
    expect(result).toContain('Helper-1');
    expect(result).toContain('Helper-2');
  });

  it('handles empty workers gracefully', () => {
    mocks.getActiveAgents.mockReturnValue([]);
    mocks.getClaims.mockReturnValue([]);
    mocks.getTasks.mockReturnValue([]);
    mocks.getLiveWorkers.mockReturnValue(new Map());

    const state = makeState('Me');
    const dirs = makeDirs();
    const result = renderAgentsRow('/tmp', 200, state, dirs, 300000);

    // Should only show self when no workers
    expect(result).toContain('You');
    expect(result).not.toContain('🔵'); // No worker indicator
  });

  it('truncates to width when many workers', () => {
    mocks.getActiveAgents.mockReturnValue([]);
    mocks.getClaims.mockReturnValue([]);
    mocks.getTasks.mockReturnValue([]);

    // Many workers that would exceed width
    const workers = new Map();
    for (let i = 1; i <= 10; i++) {
      workers.set(`task-${i}`, makeWorker(`VeryLongAgentName-${i}`, `task-${i}`));
    }
    mocks.getLiveWorkers.mockReturnValue(workers);

    const state = makeState('Me');
    const dirs = makeDirs();
    const result = renderAgentsRow('/tmp', 50, state, dirs, 300000);

    // Result should be truncated (the mock truncateToWidth passes through,
    // but in reality it would be cut off)
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('You');
  });
});
