import type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence } from '../types.js';
import type {
  CreatedPayload,
  ClaimedPayload,
  ProgressPayload,
  CompletedPayload,
  BlockedPayload,
} from './types.js';
import { appendTaskEvent, replayAllTasks } from './events.js';
import { taskSpecPath, writeTaskSpec, deleteTaskSpec } from './persistence.js';
import { getTasks, getAllTasks, getTask, taskExists } from './queries.js';
import { normalizeChannelId } from '../../channel.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

function allocateTaskId(cwd: string, sessionId: string): string {
  const allTasks = getAllTasks(cwd, sessionId);
  const maxId = allTasks.reduce((max, t) => {
    const match = t.id.match(/(\d+)$/);
    const num = match ? Number.parseInt(match[1], 10) : 0;
    return Math.max(max, num);
  }, 0);
  return `task-${maxId + 1}`;
}

export function createTask(
  cwd: string,
  sessionId: string,
  input: SwarmTaskCreateInput,
  channelId: string
): SwarmTask {
  const normalizedChannel = normalizeChannelId(channelId);
  const id = allocateTaskId(cwd, sessionId);
  const now = new Date().toISOString();

  // Append creation event
  appendTaskEvent(cwd, sessionId, {
    taskId: id,
    type: 'created',
    timestamp: now,
    channel: normalizedChannel,
    payload: {
      title: input.title,
      content: input.content,
      dependsOn: input.dependsOn,
      createdBy: input.createdBy,
    } as CreatedPayload,
  });

  // Write spec file separately
  writeTaskSpec(cwd, sessionId, id, input.title, input.content);

  // Return the task as it now exists
  const tasks = getTasks(cwd, sessionId);
  return tasks.find((t) => t.id === id)!;
}

export function claimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason?: string
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'todo') return null;

  // Check dependencies
  const allTasks = getTasks(cwd, sessionId);
  const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));
  const unmetDeps = task.depends_on.filter((dep) => !doneIds.has(dep));
  if (unmetDeps.length > 0) return null;

  // Append claim event
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'claimed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { reason } as ClaimedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function unclaimTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'in_progress') return null;
  if (task.claimed_by !== agentName) return null;

  // Append release event
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'released',
    timestamp: new Date().toISOString(),
    agent: agentName,
  });

  return getTask(cwd, sessionId, taskId);
}

export function blockTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  reason: string
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'blocked',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { reason, blockedBy: agentName } as BlockedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function unblockTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'unblocked',
    timestamp: new Date().toISOString(),
  });

  return getTask(cwd, sessionId, taskId);
}

export function completeTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  summary: string,
  evidence?: SwarmTaskEvidence
): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;
  if (task.status !== 'in_progress') return null;
  if (task.claimed_by !== agentName) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'completed',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { summary, evidence } as CompletedPayload,
  });

  return getTask(cwd, sessionId, taskId);
}

export function resetTask(
  cwd: string,
  sessionId: string,
  taskId: string,
  cascade: boolean = false
): SwarmTask[] {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return [];

  const resetTasks: SwarmTask[] = [];

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'reset',
    timestamp: new Date().toISOString(),
  });
  resetTasks.push(getTask(cwd, sessionId, taskId)!);

  if (cascade) {
    const allTasks = getAllTasks(cwd, sessionId);
    const doneIds = new Set(allTasks.filter((t) => t.status === 'done').map((t) => t.id));

    // Find all tasks that depend on this one (directly or transitively)
    const toReset = new Set<string>();
    const findDependents = (parentId: string) => {
      for (const t of allTasks) {
        if (t.depends_on.includes(parentId) && doneIds.has(t.id)) {
          toReset.add(t.id);
          findDependents(t.id);
        }
      }
    };
    findDependents(taskId);

    for (const dependentId of toReset) {
      appendTaskEvent(cwd, sessionId, {
        taskId: dependentId,
        type: 'reset',
        timestamp: new Date().toISOString(),
      });
      const resetTask = getTask(cwd, sessionId, dependentId);
      if (resetTask) resetTasks.push(resetTask);
    }
  }

  return resetTasks;
}

export function archiveTask(cwd: string, sessionId: string, taskId: string): SwarmTask | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return null;

  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'archived',
    timestamp: new Date().toISOString(),
  });

  // Use replayAllTasks to get the archived task
  return replayAllTasks(cwd, sessionId).find((t) => t.id === taskId) ?? null;
}

export function archiveDoneTasks(cwd: string, sessionId: string): number {
  const doneTasks = getTasks(cwd, sessionId).filter((t) => t.status === 'done');
  for (const task of doneTasks) {
    archiveTask(cwd, sessionId, task.id);
  }
  return doneTasks.length;
}

export function deleteTask(cwd: string, sessionId: string, taskId: string): boolean {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return false;

  // Remove spec file
  deleteTaskSpec(cwd, sessionId, taskId);

  // Archive to mark as deleted
  archiveTask(cwd, sessionId, taskId);

  return true;
}

export function appendTaskProgress(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string,
  message: string
): void {
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'progress',
    timestamp: new Date().toISOString(),
    agent: agentName,
    payload: { message } as ProgressPayload,
  });
}
