import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-replay';
const TEST_CHANNEL = 'test-channel';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-replay-test-'));
  roots.add(cwd);
  return cwd;
}

function getTasksJsonlPath(cwd: string, sessionId: string): string {
  return path.join(cwd, '.pi', 'messenger', 'tasks', `${sessionId}.jsonl`);
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('swarm/task-store event sourcing replay', () => {
  it('replays task from single creation event', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Simple task', content: 'Do something' },
      TEST_CHANNEL
    );

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);

    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe(task.id);
    expect(replayed[0].title).toBe('Simple task');
    expect(replayed[0].status).toBe('todo');
    expect(replayed[0].depends_on).toEqual([]);
  });

  it('replays task with dependencies', () => {
    const cwd = createTempCwd();
    const dep1 = taskStore.createTask(cwd, TEST_SESSION, { title: 'Dep 1' }, TEST_CHANNEL);
    const dep2 = taskStore.createTask(cwd, TEST_SESSION, { title: 'Dep 2' }, TEST_CHANNEL);
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Main', dependsOn: [dep1.id, dep2.id] },
      TEST_CHANNEL
    );

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.depends_on).toEqual([dep1.id, dep2.id]);
  });

  it('replays claim event to in_progress status', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Claim test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Reason here');

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.status).toBe('in_progress');
    expect(found?.claimed_by).toBe('AgentA');
    expect(found?.claim_reason).toBe('Reason here');
    expect(found?.attempt_count).toBe(1);
  });

  it('replays unclaim back to todo', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Unclaim test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.unclaimTask(cwd, TEST_SESSION, task.id, 'AgentA');

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.status).toBe('todo');
    expect(found?.claimed_by).toBeUndefined();
  });

  it('replays complete event to done status', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Complete test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'AgentA', 'All done', {
      commits: ['abc123'],
      tests: ['test.ts'],
    });

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.status).toBe('done');
    expect(found?.completed_by).toBe('AgentA');
    expect(found?.summary).toBe('All done');
    expect(found?.evidence?.commits).toEqual(['abc123']);
  });

  it('replays block and unblock events', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Block test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.blockTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Blocked reason');

    let replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    let found = replayed.find((t) => t.id === task.id);
    expect(found?.status).toBe('blocked');
    expect(found?.blocked_reason).toBe('Blocked reason');

    taskStore.unblockTask(cwd, TEST_SESSION, task.id);

    replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    found = replayed.find((t) => t.id === task.id);
    expect(found?.status).toBe('in_progress');
    expect(found?.blocked_reason).toBeUndefined();
  });

  it('replays reset event to clear all state', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Reset test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Done');
    taskStore.resetTask(cwd, TEST_SESSION, task.id, false);

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.status).toBe('todo');
    expect(found?.claimed_by).toBeUndefined();
    expect(found?.completed_by).toBeUndefined();
    expect(found?.summary).toBeUndefined();
  });

  it('replays archive event (filtered by default)', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Archive test' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Done');
    taskStore.archiveTask(cwd, TEST_SESSION, task.id);

    // replayTasks filters archived by default
    const active = taskStore.replayTasks(cwd, TEST_SESSION);
    expect(active.find((t) => t.id === task.id)).toBeUndefined();

    // replayAllTasks includes archived
    const all = taskStore.replayAllTasks(cwd, TEST_SESSION);
    const found = all.find((t) => t.id === task.id);
    expect(found?.status).toBe('archived');
    expect(found?.archived_at).toBeDefined();
  });

  it('handles out-of-order events gracefully', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Out of order' }, TEST_CHANNEL);

    // Manually append events in weird order by writing directly to JSONL
    // Events are replayed in FILE ORDER (not timestamp order) - last event wins
    const jsonlPath = getTasksJsonlPath(cwd, TEST_SESSION);
    const events = [
      {
        taskId: task.id,
        type: 'completed',
        timestamp: new Date().toISOString(),
        agent: 'AgentA',
        payload: { summary: 'Done' },
      },
      {
        taskId: task.id,
        type: 'claimed',
        timestamp: new Date(Date.now() - 1000).toISOString(),
        agent: 'AgentA',
        payload: {},
      },
      {
        taskId: task.id,
        type: 'created',
        timestamp: new Date(Date.now() - 2000).toISOString(),
        payload: { title: 'Out of order' },
      },
    ];

    // Write out of order - last event in file is 'created', so task reverts to 'todo'
    fs.writeFileSync(jsonlPath, events.map((e) => JSON.stringify(e)).join('\n'));

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    // Last event in file is 'created', so status resets to 'todo'
    // (This tests that replay processes events sequentially, last wins)
    expect(found?.status).toBe('todo');
    expect(found?.title).toBe('Out of order');
  });

  it('returns empty array for non-existent session', () => {
    const cwd = createTempCwd();
    const replayed = taskStore.replayTasks(cwd, 'non-existent-session');
    expect(replayed).toEqual([]);
  });

  it('skips malformed lines in JSONL', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Bad lines' }, TEST_CHANNEL);

    const jsonlPath = getTasksJsonlPath(cwd, TEST_SESSION);
    fs.appendFileSync(jsonlPath, '\nthis is not json\n{"bad": "event"}\n');

    // Should still return the valid task
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].title).toBe('Bad lines');
  });

  it('sorts tasks by numeric id', () => {
    const cwd = createTempCwd();
    // IDs are allocated sequentially: task-1, task-2, task-3
    const taskA = taskStore.createTask(cwd, TEST_SESSION, { title: 'First' }, TEST_CHANNEL);
    const taskB = taskStore.createTask(cwd, TEST_SESSION, { title: 'Second' }, TEST_CHANNEL);
    const taskC = taskStore.createTask(cwd, TEST_SESSION, { title: 'Third' }, TEST_CHANNEL);

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const ids = replayed.map((t) => t.id);

    // Should be sorted numerically by the number suffix
    expect(ids).toEqual([taskA.id, taskB.id, taskC.id]);
    expect(ids).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('accumulates attempt_count across multiple claims', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Retries' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.unclaimTask(cwd, TEST_SESSION, task.id, 'AgentA');
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentB');
    taskStore.unclaimTask(cwd, TEST_SESSION, task.id, 'AgentB');
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentC');

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.attempt_count).toBe(3);
  });
});
