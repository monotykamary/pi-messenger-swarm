import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSpawnedAgents,
  getAgentEventHistory,
  listSpawned,
  listSpawnedHistory,
  spawnSubagent,
} from '../../swarm/spawn.js';
import type { SpawnedAgent } from '../../swarm/types.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-spawn-events';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-spawn-replay-test-'));
  roots.add(cwd);
  return cwd;
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

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('swarm/spawn event sourcing', () => {
  it('replays single spawned event', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'TestAgent',
        role: 'Developer',
        objective: 'Write tests',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('agent-1');
    expect(agents[0].name).toBe('TestAgent');
    expect(agents[0].status).toBe('running');
    expect(agents[0].role).toBe('Developer');
  });

  it('replays completed event to final state', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();
    const endedAt = new Date().toISOString();

    // Spawn event
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'TestAgent',
        role: 'Developer',
        objective: 'Write tests',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    // Complete event
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'completed',
      timestamp: endedAt,
      agent: {
        status: 'completed',
        endedAt,
        exitCode: 0,
      },
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    const agent = agents[0];

    expect(agent.status).toBe('completed');
    expect(agent.endedAt).toBe(endedAt);
    expect(agent.exitCode).toBe(0);
    expect(agent.name).toBe('TestAgent'); // Preserved from spawn event
    expect(agent.startedAt).toBe(startedAt); // Preserved from spawn event
  });

  it('replays failed event to final state', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();
    const endedAt = new Date().toISOString();

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'FailingAgent',
        role: 'Tester',
        objective: 'Fail gracefully',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'failed',
      timestamp: endedAt,
      agent: {
        status: 'failed',
        endedAt,
        exitCode: 1,
        error: 'Process crashed',
      },
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    const agent = agents[0];

    expect(agent.status).toBe('failed');
    expect(agent.exitCode).toBe(1);
    expect(agent.error).toBe('Process crashed');
  });

  it('replays stopped event to final state', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();
    const endedAt = new Date().toISOString();

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'StoppedAgent',
        role: 'Worker',
        objective: 'Get stopped',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'stopped',
      timestamp: endedAt,
      agent: {
        status: 'stopped',
        endedAt,
        exitCode: 143, // SIGTERM
      },
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    expect(agents[0].status).toBe('stopped');
    expect(agents[0].exitCode).toBe(143);
  });

  it('merges multiple events for same agent', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    // Initial spawn
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'ProgressAgent',
        role: 'Worker',
        objective: 'Do work',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
        taskId: 'task-1',
      } as SpawnedAgent,
    });

    // Progress update (status stays running)
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'progress',
      timestamp: new Date().toISOString(),
      agent: {
        objective: 'Updated objective',
      },
    });

    // Complete
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'completed',
      timestamp: new Date().toISOString(),
      agent: {
        status: 'completed',
        endedAt: new Date().toISOString(),
        exitCode: 0,
      },
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    const agent = agents[0];

    expect(agent.status).toBe('completed');
    expect(agent.objective).toBe('Updated objective'); // From progress event
    expect(agent.name).toBe('ProgressAgent'); // From spawn event
    expect(agent.taskId).toBe('task-1'); // From spawn event
  });

  it('handles multiple agents independently', () => {
    const cwd = createTempCwd();

    // Create agents with explicit timestamps to guarantee sort order
    const now = Date.now();
    const agents = [
      {
        id: 'agent-1',
        name: 'First',
        startedAt: new Date(now - 2000).toISOString(),
        status: 'completed',
        exitCode: 0,
      },
      {
        id: 'agent-2',
        name: 'Second',
        startedAt: new Date(now - 1000).toISOString(),
        status: 'failed',
        exitCode: 1,
      },
      { id: 'agent-3', name: 'Third', startedAt: new Date(now).toISOString(), status: 'running' },
    ];

    for (const agent of agents) {
      appendRawEvent(cwd, TEST_SESSION, {
        id: agent.id,
        type: 'spawned',
        timestamp: agent.startedAt,
        agent: {
          id: agent.id,
          cwd,
          name: agent.name,
          role: 'Worker',
          objective: 'Work',
          status: 'running',
          startedAt: agent.startedAt,
          sessionId: TEST_SESSION,
        } as SpawnedAgent,
      });

      if (agent.status !== 'running') {
        appendRawEvent(cwd, TEST_SESSION, {
          id: agent.id,
          type: agent.status as 'completed' | 'failed',
          timestamp: new Date().toISOString(),
          agent: {
            status: agent.status,
            endedAt: new Date().toISOString(),
            exitCode: agent.exitCode,
          },
        });
      }
    }

    const loaded = loadSpawnedAgents(cwd, TEST_SESSION);
    expect(loaded).toHaveLength(3);

    // Sorted by startedAt descending (newest first)
    expect(loaded.map((a) => a.name)).toEqual(['Third', 'Second', 'First']);
  });

  it('returns empty array for non-existent session', () => {
    const cwd = createTempCwd();
    const agents = loadSpawnedAgents(cwd, 'non-existent-session');
    expect(agents).toEqual([]);
  });

  it('skips malformed lines', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    // Write malformed data manually
    const filePath = getAgentEventsJsonlPath(cwd, TEST_SESSION);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = [
      'this is not json',
      `{"id":"agent-1","type":"spawned","timestamp":"${startedAt}","agent":{"id":"agent-1","cwd":"${cwd}","name":"GoodAgent","role":"Worker","objective":"Work","status":"running","startedAt":"${startedAt}","sessionId":"${TEST_SESSION}"}}`,
      'also not valid json {',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    expect(agents).toHaveLength(1);
    expect(agents[0].name).toBe('GoodAgent');
  });

  it('last event wins for same agent', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    // Out of order: completed, then spawned
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'completed',
      timestamp: new Date().toISOString(),
      agent: {
        status: 'completed',
        endedAt: new Date().toISOString(),
        exitCode: 0,
      },
    });

    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'LastWinsAgent',
        role: 'Worker',
        objective: 'Work',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    const agents = loadSpawnedAgents(cwd, TEST_SESSION);
    const agent = agents[0];

    // Last event in file is 'spawned', so status is 'running'
    // (This verifies sequential replay, not timestamp ordering)
    expect(agent.status).toBe('running');
    expect(agent.name).toBe('LastWinsAgent');
  });
});

describe('swarm/spawn getAgentEventHistory', () => {
  it('returns all events for specific agent', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    // Events for agent-1
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: { id: 'agent-1', name: 'AgentOne' },
    });
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'progress',
      timestamp: new Date().toISOString(),
      agent: { objective: 'Updated' },
    });
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'completed',
      timestamp: new Date().toISOString(),
      agent: { status: 'completed' },
    });

    // Event for agent-2 (should be filtered out)
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-2',
      type: 'spawned',
      timestamp: startedAt,
      agent: { id: 'agent-2', name: 'AgentTwo' },
    });

    const history = getAgentEventHistory(cwd, TEST_SESSION, 'agent-1');

    expect(history).toHaveLength(3);
    expect(history.map((e) => e.type)).toEqual(['spawned', 'progress', 'completed']);
  });

  it('returns empty array for unknown agent', () => {
    const cwd = createTempCwd();
    const history = getAgentEventHistory(cwd, TEST_SESSION, 'unknown-agent');
    expect(history).toEqual([]);
  });
});

describe('swarm/spawn listSpawned vs listSpawnedHistory', () => {
  it('listSpawned filters to running only by default', () => {
    const cwd = createTempCwd();
    const startedAt = new Date().toISOString();

    // Running agent
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-1',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-1',
        cwd,
        name: 'RunningAgent',
        role: 'Worker',
        objective: 'Work',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });

    // Completed agent
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-2',
      type: 'spawned',
      timestamp: startedAt,
      agent: {
        id: 'agent-2',
        cwd,
        name: 'CompletedAgent',
        role: 'Worker',
        objective: 'Done',
        status: 'running',
        startedAt,
        sessionId: TEST_SESSION,
      } as SpawnedAgent,
    });
    appendRawEvent(cwd, TEST_SESSION, {
      id: 'agent-2',
      type: 'completed',
      timestamp: new Date().toISOString(),
      agent: { status: 'completed', endedAt: new Date().toISOString(), exitCode: 0 },
    });

    const running = listSpawned(cwd, TEST_SESSION);
    expect(running).toHaveLength(1);
    expect(running[0].name).toBe('RunningAgent');

    const history = listSpawnedHistory(cwd, TEST_SESSION);
    expect(history).toHaveLength(2);
  });
});
