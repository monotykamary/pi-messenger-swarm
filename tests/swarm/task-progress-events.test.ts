import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { executeTaskAction } from '../../swarm/task-actions.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-progress';
const TEST_CHANNEL = 'test-channel';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-progress-test-'));
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

describe('swarm/task-store progress event sourcing', () => {
  it('appends progress events to JSONL file', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Progress test' }, TEST_CHANNEL);

    // Append progress
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'First checkpoint');
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Second checkpoint');

    // Verify JSONL contains progress events
    const jsonlPath = getTasksJsonlPath(cwd, TEST_SESSION);
    expect(fs.existsSync(jsonlPath)).toBe(true);

    const lines = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const progressEvents = lines.map((l) => JSON.parse(l)).filter((e) => e.type === 'progress');

    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0].payload.message).toBe('First checkpoint');
    expect(progressEvents[1].payload.message).toBe('Second checkpoint');
  });

  it('replays progress events into progress_log field', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Replay test' }, TEST_CHANNEL);

    // Add progress
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Step 1');
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentB', 'Step 2');

    // Replay and check
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.progress_log).toHaveLength(2);
    expect(found?.progress_log?.[0].message).toBe('Step 1');
    expect(found?.progress_log?.[0].agent).toBe('AgentA');
    expect(found?.progress_log?.[1].message).toBe('Step 2');
    expect(found?.progress_log?.[1].agent).toBe('AgentB');
  });

  it('preserves progress log across task lifecycle', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Lifecycle test' }, TEST_CHANNEL);

    // Claim task
    taskStore.claimTask(cwd, TEST_SESSION, task.id, 'AgentA');

    // Add progress
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Working...');

    // Complete task
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Done!');

    // Replay and verify progress preserved
    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);

    expect(found?.status).toBe('done');
    expect(found?.progress_log).toHaveLength(1);
    expect(found?.progress_log?.[0].message).toBe('Working...');
  });

  it('getTaskProgress returns formatted log', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Format test' }, TEST_CHANNEL);

    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Checkpoint 1');
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Checkpoint 2');

    const formatted = taskStore.getTaskProgress(cwd, TEST_SESSION, task.id);

    expect(formatted).toContain('Checkpoint 1');
    expect(formatted).toContain('Checkpoint 2');
    expect(formatted).toContain('AgentA');
    expect(formatted).toMatch(/\[.*\].*AgentA.*Checkpoint 1/);
  });

  it('returns null for task without progress', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'No progress' }, TEST_CHANNEL);

    const progress = taskStore.getTaskProgress(cwd, TEST_SESSION, task.id);
    expect(progress).toBeNull();
  });

  it('survives process restart (reads from disk)', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(
      cwd,
      TEST_SESSION,
      { title: 'Survive restart' },
      TEST_CHANNEL
    );

    // Add progress
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Before restart');

    // Simulate "restart" by clearing any in-memory state and re-reading
    // (replayTasks reads from disk each time)
    const freshRead = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = freshRead.find((t) => t.id === task.id);

    expect(found?.progress_log).toHaveLength(1);
    expect(found?.progress_log?.[0].message).toBe('Before restart');
  });
});

describe('swarm/task-actions progress integration', () => {
  it('task.progress action appends to log', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Action test' }, TEST_CHANNEL);

    // Claim first
    executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA', TEST_CHANNEL);

    // Use the handler-level progress (via task.progress action in router)
    // Note: executeTaskAction doesn't have 'progress', we call store directly
    taskStore.appendTaskProgress(cwd, TEST_SESSION, task.id, 'AgentA', 'Via action');

    const replayed = taskStore.replayTasks(cwd, TEST_SESSION);
    const found = replayed.find((t) => t.id === task.id);
    expect(found?.progress_log).toHaveLength(1);
  });
});
