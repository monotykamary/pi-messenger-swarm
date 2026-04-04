import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import * as store from '../../store.js';
import { logFeedEvent, readFeedEvents } from '../../feed.js';
import { createTempMessengerDirs } from '../helpers/temp-dirs.js';
import type { MessengerState, Dirs } from '../../lib.js';

const TEST_SESSION = 'test-session-shutdown';

describe('swarm/session-shutdown-cleanup', () => {
  afterEach(() => {
    // Cleanup is handled by temp-dirs.ts afterEach
  });

  it('should unclaim all tasks when agent leaves', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Create and claim multiple tasks
    const task1 = taskStore.createTask(dirs.cwd, TEST_SESSION, {
      title: 'Task 1',
      createdBy: agentName,
    });
    const task2 = taskStore.createTask(dirs.cwd, TEST_SESSION, {
      title: 'Task 2',
      createdBy: agentName,
    });
    const task3 = taskStore.createTask(dirs.cwd, TEST_SESSION, {
      title: 'Task 3',
      createdBy: 'OtherAgent',
    });

    // Claim tasks as the agent
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task1.id, agentName);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task2.id, agentName);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task3.id, 'OtherAgent');

    // Verify tasks are claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.claimed_by).toBe(agentName);
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.claimed_by).toBe(agentName);
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.claimed_by).toBe('OtherAgent');

    // Simulate agent leaving - cleanup only this agent's claims
    const claimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === agentName);
    expect(claimedTasks).toHaveLength(2);

    for (const task of claimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, agentName);
    }

    // Verify agent's tasks are unclaimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.claimed_by).toBeUndefined();
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.claimed_by).toBeUndefined();

    // Other agent's task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.claimed_by).toBe('OtherAgent');
  });

  it('should handle cleanup when agent has no claimed tasks', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Create tasks claimed by other agents
    const task1 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 1' });
    const task2 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 2' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task1.id, 'OtherAgent1');
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task2.id, 'OtherAgent2');

    // Agent has no tasks - cleanup should be a no-op
    const claimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === agentName);
    expect(claimedTasks).toHaveLength(0);

    // Cleanup should not throw or affect other agents' tasks
    for (const task of claimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, agentName);
    }

    // Verify other agents' tasks are untouched
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.claimed_by).toBe('OtherAgent1');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.claimed_by).toBe('OtherAgent2');
  });

  it('should unclaim tasks claimed by spawned agents', () => {
    const dirs = createTempMessengerDirs();
    const parentAgent = 'ParentAgent';
    const spawnedAgent1 = 'SpawnedAgent-Alpha';
    const spawnedAgent2 = 'SpawnedAgent-Beta';
    const otherAgent = 'OtherAgent';

    // Create tasks
    const task1 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Spawned Task 1' });
    const task2 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Spawned Task 2' });
    const task3 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Other Task' });
    const parentTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Parent Task' });

    // Claim tasks as spawned agents and parent
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task1.id, spawnedAgent1);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task2.id, spawnedAgent2);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task3.id, otherAgent);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, parentTask.id, parentAgent);

    // Simulate parent agent leaving with spawned agents
    // First, get spawned agent names (normally from listSpawned)
    const spawnedNames = new Set([spawnedAgent1, spawnedAgent2]);

    // Cleanup parent agent's tasks
    const parentClaimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === parentAgent);
    for (const task of parentClaimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, parentAgent);
    }

    // Cleanup spawned agents' tasks
    const spawnedClaimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by && spawnedNames.has(t.claimed_by));
    expect(spawnedClaimedTasks).toHaveLength(2);

    for (const task of spawnedClaimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, task.claimed_by!);
    }

    // Verify parent and spawned agents' tasks are unclaimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, parentTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, parentTask.id)?.claimed_by).toBeUndefined();
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.claimed_by).toBeUndefined();
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.claimed_by).toBeUndefined();

    // Other agent's task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.claimed_by).toBe(otherAgent);
  });

  it('should handle cleanup with mixed task states', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Create tasks in various states
    const todoTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Todo Task' });
    const claimedTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Claimed Task' });
    const doneTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Done Task' });
    const blockedTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Blocked Task' });

    // Set up different task states
    taskStore.claimTask(dirs.cwd, TEST_SESSION, claimedTask.id, agentName);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, doneTask.id, agentName);
    taskStore.completeTask(dirs.cwd, TEST_SESSION, doneTask.id, agentName, 'Completed');
    taskStore.claimTask(dirs.cwd, TEST_SESSION, blockedTask.id, agentName);
    taskStore.blockTask(dirs.cwd, TEST_SESSION, blockedTask.id, agentName, 'Waiting for API');

    // Verify initial states
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, todoTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, claimedTask.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, doneTask.id)?.status).toBe('done');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, blockedTask.id)?.status).toBe('blocked');

    // Simulate agent leaving - cleanup only in_progress tasks
    const claimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === agentName);
    expect(claimedTasks).toHaveLength(1); // Only claimedTask, not done or blocked

    for (const task of claimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, agentName);
    }

    // Verify only claimed task was affected
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, todoTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, claimedTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, claimedTask.id)?.claimed_by).toBeUndefined();
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, doneTask.id)?.status).toBe('done'); // Unchanged
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, blockedTask.id)?.status).toBe('blocked'); // Unchanged
  });

  it('should only unclaim tasks for the specific agent, not others', () => {
    const dirs = createTempMessengerDirs();
    const leavingAgent = 'LeavingAgent';
    const stayingAgent = 'StayingAgent';

    // Create and claim tasks by different agents
    const task1 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 1' });
    const task2 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 2' });
    const task3 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 3' });

    taskStore.claimTask(dirs.cwd, TEST_SESSION, task1.id, leavingAgent);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task2.id, stayingAgent);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task3.id, leavingAgent);

    // Cleanup only leaving agent's tasks
    const leavingAgentTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === leavingAgent);
    expect(leavingAgentTasks).toHaveLength(2);

    for (const task of leavingAgentTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, leavingAgent);
    }

    // Verify leaving agent's tasks are unclaimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task1.id)?.claimed_by).toBeUndefined();
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task3.id)?.claimed_by).toBeUndefined();

    // Verify staying agent's task is still claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task2.id)?.claimed_by).toBe(stayingAgent);
  });

  it('should log feed events when agent leaves and tasks are unclaimed', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Verify feed file doesn't exist yet
    const feedFile = path.join(dirs.cwd, '.pi', 'messenger', 'feed', 'general.jsonl');
    expect(fs.existsSync(feedFile)).toBe(false);

    // Create and claim tasks
    const task1 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 1' });
    const task2 = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Task 2' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task1.id, agentName);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task2.id, agentName);

    // Simulate agent leaving with feed event logging
    const claimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by === agentName);

    for (const task of claimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, task.id, agentName);
      logFeedEvent(dirs.cwd, agentName, 'task.reset', task.id, 'agent left - task unclaimed');
    }
    logFeedEvent(dirs.cwd, agentName, 'leave');

    // Verify feed events were logged
    expect(fs.existsSync(feedFile)).toBe(true);
    const events = readFeedEvents(dirs.cwd, 20);
    expect(events).toHaveLength(3); // 2 task resets + 1 leave

    // Verify task reset events
    const resetEvents = events.filter((e) => e.type === 'task.reset');
    expect(resetEvents).toHaveLength(2);
    expect(resetEvents[0]?.agent).toBe(agentName);
    expect(resetEvents[0]?.preview).toBe('agent left - task unclaimed');
    expect([resetEvents[0]?.target, resetEvents[1]?.target]).toContain(task1.id);
    expect([resetEvents[0]?.target, resetEvents[1]?.target]).toContain(task2.id);

    // Verify leave event
    const leaveEvent = events.find((e) => e.type === 'leave');
    expect(leaveEvent).toBeDefined();
    expect(leaveEvent?.agent).toBe(agentName);
  });

  it('should log feed events when parent agent cleans up spawned agent tasks', () => {
    const dirs = createTempMessengerDirs();
    const parentAgent = 'ParentAgent';
    const spawnedAgent = 'SpawnedAgent-Alpha';

    // Create and claim task as spawned agent
    const task = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Spawned Task' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task.id, spawnedAgent);

    // Simulate parent agent cleaning up spawned agent's tasks
    const spawnedNames = new Set([spawnedAgent]);
    const spawnedClaimedTasks = taskStore
      .getTasks(dirs.cwd, TEST_SESSION)
      .filter((t) => t.status === 'in_progress' && t.claimed_by && spawnedNames.has(t.claimed_by));

    for (const t of spawnedClaimedTasks) {
      taskStore.unclaimTask(dirs.cwd, TEST_SESSION, t.id, t.claimed_by!);
      logFeedEvent(
        dirs.cwd,
        t.claimed_by!,
        'task.reset',
        t.id,
        'parent agent left - task unclaimed'
      );
    }

    // Verify feed event was logged
    const events = readFeedEvents(dirs.cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('task.reset');
    expect(events[0]?.agent).toBe(spawnedAgent);
    expect(events[0]?.preview).toBe('parent agent left - task unclaimed');
    expect(events[0]?.target).toBe(task.id);
  });

  it('should clean up file reservations when agent leaves', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Create messenger directories structure
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    const inboxDir = path.join(dirs.cwd, '.pi', 'messenger', 'inbox');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.mkdirSync(path.join(inboxDir, agentName), { recursive: true });

    // Create registration file for the leaving agent with reservations
    const leavingRegPath = path.join(registryDir, `${agentName}.json`);
    const registration = {
      name: agentName,
      pid: process.pid,
      sessionId: 'test-session-1',
      cwd: dirs.cwd,
      model: 'test-model',
      startedAt: new Date().toISOString(),
      reservations: [
        { pattern: 'src/auth.ts', reason: 'Working on auth', since: new Date().toISOString() },
        { pattern: 'src/user.ts', reason: 'User service changes', since: new Date().toISOString() },
      ],
    };
    fs.writeFileSync(leavingRegPath, JSON.stringify(registration, null, 2));

    // Verify registration file exists
    expect(fs.existsSync(leavingRegPath)).toBe(true);

    // Create a mock state for the leaving agent
    const mockState = {
      agentName,
      registered: true,
      reservations: registration.reservations,
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
      watcher: null,
      watcherRetries: 0,
      watcherRetryTimer: null,
      watcherDebounceTimer: null,
    } as unknown as MessengerState;

    const mockDirs: Dirs = {
      base: path.join(dirs.cwd, '.pi', 'messenger'),
      registry: registryDir,
      inbox: inboxDir,
    };

    // Call unregister (simulating session_shutdown)
    store.unregister(mockState, mockDirs);

    // Verify leaving agent's registration file is deleted (this removes all reservations)
    expect(fs.existsSync(leavingRegPath)).toBe(false);

    // Verify the agent is now unregistered
    expect(mockState.registered).toBe(false);
  });

  it('should auto-unclaim tasks from crashed agents during reconciliation', () => {
    const dirs = createTempMessengerDirs();
    const deadAgent = 'DeadAgent';
    const liveAgent = 'LiveAgent';

    // Create registry directory
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });

    // Create a task claimed by a dead agent (PID 99999 doesn't exist)
    const deadTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Dead Agent Task' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, deadTask.id, deadAgent);

    // Create registration for dead agent with invalid PID
    const deadRegPath = path.join(registryDir, `${deadAgent}.json`);
    fs.writeFileSync(
      deadRegPath,
      JSON.stringify(
        {
          name: deadAgent,
          pid: 99999, // Non-existent PID
          sessionId: 'dead-session',
          cwd: dirs.cwd,
          model: 'test-model',
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    // Create a task claimed by live agent (current process)
    const liveTask = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Live Agent Task' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, liveTask.id, liveAgent);

    // Create registration for live agent with valid PID
    const liveRegPath = path.join(registryDir, `${liveAgent}.json`);
    fs.writeFileSync(
      liveRegPath,
      JSON.stringify(
        {
          name: liveAgent,
          pid: process.pid, // Valid PID
          sessionId: 'live-session',
          cwd: dirs.cwd,
          model: 'test-model',
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    // Verify initial state
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.claimed_by).toBe(deadAgent);
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.claimed_by).toBe(liveAgent);

    // Call cleanup directly (normally called via getTasks throttling)
    const cleaned = taskStore.cleanupStaleTaskClaims(dirs.cwd, TEST_SESSION);

    // Should clean up 1 stale claim
    expect(cleaned).toBe(1);

    // Dead agent's task should be unclaimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.claimed_by).toBeUndefined();

    // Live agent's task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.claimed_by).toBe(liveAgent);

    // Verify feed event was logged
    const events = readFeedEvents(dirs.cwd, 20);
    const cleanupEvent = events.find((e) => e.type === 'task.reset' && e.agent === deadAgent);
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent?.target).toBe(deadTask.id);
    expect(cleanupEvent?.preview).toContain('agent crashed');
  });

  it('should not clean up tasks when registry does not exist (unknown agent state)', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'SomeAgent';

    // Create a task claimed by agent (no registry exists)
    const task = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Unknown Agent Task' });
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task.id, agentName);

    // Verify initial state
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task.id)?.status).toBe('in_progress');

    // Call cleanup - should skip because no registry exists
    const cleaned = taskStore.cleanupStaleTaskClaims(dirs.cwd, TEST_SESSION);

    // Should not clean up anything (unknown state, be conservative)
    expect(cleaned).toBe(0);

    // Task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task.id)?.claimed_by).toBe(agentName);
  });
});
