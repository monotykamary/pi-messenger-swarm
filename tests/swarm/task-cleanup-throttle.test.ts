import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { readFeedEvents } from '../../feed.js';
import { createTempMessengerDirs } from '../helpers/temp-dirs.js';

const TEST_SESSION = 'test-cleanup-throttle';
const TEST_CHANNEL = 'test-channel';

describe('swarm/task-cleanup-throttle', () => {
  afterEach(() => {
    // Reset the cleanup throttle to ensure fresh state for each test
    taskStore._resetCleanupThrottle();
  });

  it('should auto-unclaim tasks from crashed agents when getTasks is called', () => {
    const dirs = createTempMessengerDirs();
    const deadAgent = 'DeadAgent';
    const liveAgent = 'LiveAgent';

    // Create registry directory
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });

    // Create a task claimed by a dead agent (PID 99999 doesn't exist)
    const deadTask = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Dead Agent Task' },
      TEST_CHANNEL
    );
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
    const liveTask = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Live Agent Task' },
      TEST_CHANNEL
    );
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

    // Verify initial state (cleanup already ran during claimTask for dependencies)
    // Reset throttle so we can trigger a fresh cleanup now that tasks are claimed
    taskStore._resetCleanupThrottle(dirs.cwd, TEST_SESSION);

    // Call getTasks - this should trigger fresh cleanup
    const tasks = taskStore.getTasks(dirs.cwd, TEST_SESSION);
    expect(tasks).toHaveLength(2);

    // Dead agent's task should be auto-unclaimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, deadTask.id)?.claimed_by).toBeUndefined();

    // Live agent's task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.claimed_by).toBe(liveAgent);

    // Verify feed event was logged
    const events = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const cleanupEvent = events.find((e) => e.type === 'task.reset' && e.agent === deadAgent);
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent?.target).toBe(deadTask.id);
    expect(cleanupEvent?.preview).toContain('agent crashed');
  });

  it('should throttle cleanup calls to avoid excessive checks', () => {
    const dirs = createTempMessengerDirs();
    const deadAgent = 'DeadAgent';

    // Create registry directory
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });

    // Create a task claimed by dead agent
    const task = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Dead Agent Task' },
      TEST_CHANNEL
    );
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task.id, deadAgent);

    // Create registration for dead agent
    const deadRegPath = path.join(registryDir, `${deadAgent}.json`);
    fs.writeFileSync(
      deadRegPath,
      JSON.stringify(
        {
          name: deadAgent,
          pid: 99999,
          sessionId: 'dead-session',
          cwd: dirs.cwd,
          model: 'test-model',
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    // Reset throttle and trigger first cleanup
    taskStore._resetCleanupThrottle(dirs.cwd, TEST_SESSION);
    taskStore.getTasks(dirs.cwd, TEST_SESSION);

    const eventsAfterFirst = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const firstCleanupCount = eventsAfterFirst.filter((e) => e.type === 'task.reset').length;
    expect(firstCleanupCount).toBe(1); // Cleanup ran

    // Immediately call getTasks again - should be throttled, no new cleanup
    taskStore.getTasks(dirs.cwd, TEST_SESSION);
    const eventsAfterSecond = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const secondCleanupCount = eventsAfterSecond.filter((e) => e.type === 'task.reset').length;
    expect(secondCleanupCount).toBe(1); // Still only 1, no new cleanup
  });

  it('should auto-unclaim tasks when agent registry is removed', () => {
    const dirs = createTempMessengerDirs();
    const departedAgent = 'DepartedAgent';
    const liveAgent = 'LiveAgent';

    // Create registry directory
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(registryDir, { recursive: true });

    // Create tasks
    const departedTask = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Departed Agent Task' },
      TEST_CHANNEL
    );
    taskStore.claimTask(dirs.cwd, TEST_SESSION, departedTask.id, departedAgent);

    const liveTask = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Live Agent Task' },
      TEST_CHANNEL
    );
    taskStore.claimTask(dirs.cwd, TEST_SESSION, liveTask.id, liveAgent);

    // Create registry for live agent only
    fs.writeFileSync(
      path.join(registryDir, `${liveAgent}.json`),
      JSON.stringify(
        {
          name: liveAgent,
          pid: process.pid,
          sessionId: 'live-session',
          cwd: dirs.cwd,
          model: 'test-model',
          startedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    // No registry for departedAgent (simulating they left)

    // Reset throttle to trigger fresh cleanup
    taskStore._resetCleanupThrottle(dirs.cwd, TEST_SESSION);

    // Call getTasks to trigger cleanup
    taskStore.getTasks(dirs.cwd, TEST_SESSION);

    // Departed agent's task should be auto-unclaimed (agent left scenario)
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, departedTask.id)?.status).toBe('todo');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, departedTask.id)?.claimed_by).toBeUndefined();

    // Live agent's task should still be claimed
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, liveTask.id)?.status).toBe('in_progress');

    // Verify feed event
    const events = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const cleanupEvent = events.find((e) => e.type === 'task.reset' && e.agent === departedAgent);
    expect(cleanupEvent).toBeDefined();
    expect(cleanupEvent?.preview).toContain('agent left');
  });

  it('should not clean up when no registry exists at all (unknown state)', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'SomeAgent';

    // Create a task claimed by agent (no registry exists)
    const task = taskStore.createTask(
      dirs.cwd,
      TEST_SESSION,
      { title: 'Unknown Agent Task' },
      TEST_CHANNEL
    );
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task.id, agentName);

    // Reset throttle to trigger fresh cleanup check
    taskStore._resetCleanupThrottle(dirs.cwd, TEST_SESSION);

    // Call getTasks - should NOT clean up since no registry exists
    taskStore.getTasks(dirs.cwd, TEST_SESSION);

    // Task should still be claimed (conservative behavior)
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task.id)?.status).toBe('in_progress');
    expect(taskStore.getTask(dirs.cwd, TEST_SESSION, task.id)?.claimed_by).toBe(agentName);

    // Verify no feed events
    const events = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const resetEvents = events.filter((e) => e.type === 'task.reset');
    expect(resetEvents).toHaveLength(0);
  });

  it('should handle cleanup errors gracefully without breaking getTasks', () => {
    const dirs = createTempMessengerDirs();
    const agentName = 'TestAgent';

    // Create a task
    const task = taskStore.createTask(dirs.cwd, TEST_SESSION, { title: 'Test Task' }, TEST_CHANNEL);
    taskStore.claimTask(dirs.cwd, TEST_SESSION, task.id, agentName);

    // Create registry path that will cause errors (file instead of directory)
    const registryDir = path.join(dirs.cwd, '.pi', 'messenger', 'registry');
    fs.mkdirSync(path.dirname(registryDir), { recursive: true });
    fs.writeFileSync(registryDir, 'not a directory'); // Make it a file to cause errors

    // Reset throttle
    taskStore._resetCleanupThrottle(dirs.cwd, TEST_SESSION);

    // getTasks should still work despite cleanup error
    const tasks = taskStore.getTasks(dirs.cwd, TEST_SESSION);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.id).toBe(task.id);

    // Cleanup should have failed silently
    const events = readFeedEvents(dirs.cwd, 20, TEST_CHANNEL);
    const resetEvents = events.filter((e) => e.type === 'task.reset');
    expect(resetEvents).toHaveLength(0);
  });
});
