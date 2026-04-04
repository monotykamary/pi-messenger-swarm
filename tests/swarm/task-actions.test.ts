import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';
import { executeTaskAction } from '../../swarm/task-actions.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-actions';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-actions-'));
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
});

describe('swarm/task-actions', () => {
  it('start claims todo task', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Start me' });

    const res = executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA');

    expect(res.success).toBe(true);
    expect(res.task?.status).toBe('in_progress');
    expect(res.task?.claimed_by).toBe('AgentA');
  });

  it('start blocks on unmet dependencies', () => {
    const cwd = createTempCwd();
    const dep = taskStore.createTask(cwd, TEST_SESSION, { title: 'Dependency' });
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Main', dependsOn: [dep.id] });

    const res = executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA');

    expect(res.success).toBe(false);
    expect(res.error).toBe('unmet_dependencies');
    expect(res.unmetDependencies).toEqual([dep.id]);
  });

  it('block and unblock transitions state', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Block flow' });

    // Claim first
    executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA');

    // Block
    const blocked = executeTaskAction(
      cwd,
      TEST_SESSION,
      'block',
      task.id,
      'AgentA',
      'Needs review'
    );
    expect(blocked.success).toBe(true);
    expect(blocked.task?.status).toBe('blocked');

    // Unblock
    const unblocked = executeTaskAction(cwd, TEST_SESSION, 'unblock', task.id, 'AgentA');
    expect(unblocked.success).toBe(true);
    expect(unblocked.task?.status).toBe('in_progress');
  });

  it('delete removes task', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Delete me' });

    const res = executeTaskAction(cwd, TEST_SESSION, 'delete', task.id, 'AgentA');

    expect(res.success).toBe(true);
    expect(taskStore.getTask(cwd, TEST_SESSION, task.id)).toBeUndefined();
  });

  it('archive requires done status', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Archive test' });

    // Cannot archive todo task
    const todoRes = executeTaskAction(cwd, TEST_SESSION, 'archive', task.id, 'AgentA');
    expect(todoRes.success).toBe(false);
    expect(todoRes.error).toBe('invalid_status');

    // Claim and complete
    executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, task.id, 'AgentA', 'Done!');

    // Now archive should work
    const archived = executeTaskAction(cwd, TEST_SESSION, 'archive', task.id, 'AgentA');
    expect(archived.success).toBe(true);
    expect(archived.task?.status).toBe('archived');
  });

  it('reset single task', () => {
    const cwd = createTempCwd();
    const parent = taskStore.createTask(cwd, TEST_SESSION, { title: 'Parent' });
    const child = taskStore.createTask(cwd, TEST_SESSION, {
      title: 'Child',
      dependsOn: [parent.id],
    });

    // Complete both
    executeTaskAction(cwd, TEST_SESSION, 'start', parent.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, parent.id, 'AgentA', 'Done');
    executeTaskAction(cwd, TEST_SESSION, 'start', child.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, child.id, 'AgentA', 'Done');

    expect(taskStore.getTask(cwd, TEST_SESSION, parent.id)?.status).toBe('done');
    expect(taskStore.getTask(cwd, TEST_SESSION, child.id)?.status).toBe('done');

    // Reset only parent
    const single = executeTaskAction(cwd, TEST_SESSION, 'reset', parent.id, 'AgentA');
    expect(single.success).toBe(true);
    expect(taskStore.getTask(cwd, TEST_SESSION, parent.id)?.status).toBe('todo');
    expect(taskStore.getTask(cwd, TEST_SESSION, child.id)?.status).toBe('done');
  });

  it('cascade-reset resets dependent tasks', () => {
    const cwd = createTempCwd();
    const parent = taskStore.createTask(cwd, TEST_SESSION, { title: 'Parent' });
    const child = taskStore.createTask(cwd, TEST_SESSION, {
      title: 'Child',
      dependsOn: [parent.id],
    });

    // Complete both
    executeTaskAction(cwd, TEST_SESSION, 'start', parent.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, parent.id, 'AgentA', 'Done');
    executeTaskAction(cwd, TEST_SESSION, 'start', child.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, child.id, 'AgentA', 'Done');

    // Cascade reset parent
    const cascade = executeTaskAction(cwd, TEST_SESSION, 'cascade-reset', parent.id, 'AgentA');
    expect(cascade.success).toBe(true);
    expect(cascade.resetTasks?.length).toBe(2);
    expect(taskStore.getTask(cwd, TEST_SESSION, parent.id)?.status).toBe('todo');
    expect(taskStore.getTask(cwd, TEST_SESSION, child.id)?.status).toBe('todo');
  });

  it('stop releases in_progress task', () => {
    const cwd = createTempCwd();
    const task = taskStore.createTask(cwd, TEST_SESSION, { title: 'Stop me' });

    // Claim first
    executeTaskAction(cwd, TEST_SESSION, 'start', task.id, 'AgentA');
    expect(taskStore.getTask(cwd, TEST_SESSION, task.id)?.status).toBe('in_progress');

    // Stop
    const stopped = executeTaskAction(cwd, TEST_SESSION, 'stop', task.id, 'AgentA');
    expect(stopped.success).toBe(true);
    expect(stopped.task?.status).toBe('todo');
    expect(stopped.task?.claimed_by).toBeUndefined();
  });
});
