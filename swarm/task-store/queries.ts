import type { SwarmTask, SwarmSummary } from '../types.js';
import { replayTasks, replayAllTasks, appendTaskEvent } from './events.js';
import { readTaskSpec } from './persistence.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProcessAlive } from '../../lib.js';
import { logFeedEvent } from '../../feed/index.js';

// Throttled cleanup tracking per cwd+sessionId
const lastCleanupTime = new Map<string, number>();
const CLEANUP_THROTTLE_MS = 5_000; // Max once per 5 seconds per session

/** Reset cleanup throttle for testing */
export function _resetCleanupThrottle(cwd?: string, sessionId?: string): void {
  if (cwd && sessionId) {
    lastCleanupTime.delete(`${cwd}:${sessionId}`);
  } else {
    lastCleanupTime.clear();
  }
}

/**
 * Check if an agent is active based on registry file and PID.
 * Returns: true (active), false (crashed/dead), null (unknown/no registry)
 */
function isAgentActive(cwd: string, agentName: string): boolean | null {
  const regPath = path.join(cwd, '.pi', 'messenger', 'registry', `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    if (!reg.pid || !isProcessAlive(reg.pid)) return false;
    return true;
  } catch {
    return null;
  }
}

/**
 * Clean up stale task claims from crashed or departed agents.
 * Returns the number of claims that were cleaned up.
 */
function cleanupStaleTaskClaims(cwd: string, sessionId: string): number {
  const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
  if (!fs.existsSync(registryDir)) return 0;

  // Use replayTasks directly instead of getTasks to avoid triggering cleanup recursively
  const tasks = replayTasks(cwd, sessionId);
  let cleaned = 0;

  const knownAgents = fs.existsSync(registryDir)
    ? fs
        .readdirSync(registryDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
    : [];

  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.claimed_by) continue;

    const active = isAgentActive(cwd, task.claimed_by);
    if (active === false) {
      // Append release event directly (same as unclaimTask)
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      logFeedEvent(
        cwd,
        task.claimed_by,
        'task.reset',
        task.id,
        'agent crashed - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    } else if (active === null && knownAgents.length > 0) {
      // Append release event directly (same as unclaimTask)
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      logFeedEvent(
        cwd,
        task.claimed_by,
        'task.reset',
        task.id,
        'agent left - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    }
  }

  return cleaned;
}

/**
 * Get tasks with throttled cleanup of stale claims.
 */
export function getTasks(cwd: string, sessionId: string): SwarmTask[] {
  const key = `${cwd}:${sessionId}`;
  const now = Date.now();
  const lastCleanup = lastCleanupTime.get(key) ?? 0;

  // Throttled cleanup of stale claims from crashed/departed agents
  if (now - lastCleanup > CLEANUP_THROTTLE_MS) {
    lastCleanupTime.set(key, now);
    try {
      cleanupStaleTaskClaims(cwd, sessionId);
    } catch {
      // Ignore errors - cleanup is best-effort
    }
  }

  return replayTasks(cwd, sessionId);
}

export function getAllTasks(cwd: string, sessionId: string): SwarmTask[] {
  return replayAllTasks(cwd, sessionId);
}

export function getTask(cwd: string, sessionId: string, taskId: string): SwarmTask | undefined {
  return replayTasks(cwd, sessionId).find((t) => t.id === taskId);
}

export function taskExists(cwd: string, sessionId: string, taskId: string): boolean {
  return getTask(cwd, sessionId, taskId) !== undefined;
}

export function getSummary(cwd: string, sessionId: string): SwarmSummary {
  return getSummaryForTasks(getTasks(cwd, sessionId));
}

export function getSummaryForTasks(tasks: SwarmTask[]): SwarmSummary {
  return {
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    in_progress: tasks.filter((t) => t.status === 'in_progress').length,
    done: tasks.filter((t) => t.status === 'done').length,
    blocked: tasks.filter((t) => t.status === 'blocked').length,
  };
}

export function getReadyTasks(cwd: string, sessionId: string): SwarmTask[] {
  return getReadyTasksForTasks(getTasks(cwd, sessionId));
}

export function getReadyTasksForTasks(tasks: SwarmTask[]): SwarmTask[] {
  const doneIds = new Set(tasks.filter((t) => t.status === 'done').map((t) => t.id));
  return tasks.filter((t) => t.status === 'todo' && t.depends_on.every((dep) => doneIds.has(dep)));
}

export function getTaskSpec(cwd: string, sessionId: string, taskId: string): string | null {
  return readTaskSpec(cwd, sessionId, taskId);
}

/**
 * Get progress log for a task from the task's progress_log field.
 */
export function getTaskProgress(cwd: string, sessionId: string, taskId: string): string | null {
  const task = getTask(cwd, sessionId, taskId);
  if (!task?.progress_log || task.progress_log.length === 0) return null;

  return task.progress_log
    .map((entry) => {
      const timestamp = new Date(entry.timestamp).toLocaleString();
      return `[${timestamp}] ${entry.agent}: ${entry.message}`;
    })
    .join('\n');
}
