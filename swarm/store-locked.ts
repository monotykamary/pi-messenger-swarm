/**
 * Race-safe versions of swarm store operations using `await using` locks.
 * 
 * This module provides drop-in replacements for claimTask, unclaimTask, 
 * completeTask, and updateTask with proper file locking.
 * 
 * @example
 * ```typescript
 * // Old (race-prone):
 * const claimed = claimTask(cwd, "task-1", agent);
 * 
 * // New (race-safe):
 * const claimed = await claimTaskLocked(cwd, "task-1", agent);
 * ```
 */

import * as store from "./store.js";
import { TaskLock, withTaskLock } from "./lock.js";
import type { SwarmTask, SwarmTaskEvidence } from "./types.js";

/**
 * Race-safe task claim with automatic locking.
 * 
 * Uses `await using` internally for clean lock management.
 * Guarantees exclusive access during the read-check-write cycle.
 */
export async function claimTaskLocked(
  cwd: string,
  taskId: string,
  agent: string,
  reason?: string
): Promise<SwarmTask | null> {
  return await withTaskLock(cwd, taskId, async () => {
    // Re-check conditions under lock - they may have changed!
    const task = store.getTask(cwd, taskId);
    if (!task || task.status !== "todo") {
      return null;
    }

    // Check dependencies under lock
    const readyIds = new Set(store.getReadyTasks(cwd).map(t => t.id));
    if (task.depends_on.length > 0 && !readyIds.has(taskId)) {
      return null;
    }

    // Safe to claim - we hold the exclusive lock
    const claimed = store.updateTask(cwd, taskId, {
      status: "in_progress",
      claimed_by: agent,
      claimed_at: new Date().toISOString(),
      blocked_reason: undefined,
      attempt_count: (task.attempt_count ?? 0) + 1,
    });

    if (claimed && reason) {
      store.appendTaskProgress(cwd, taskId, agent, `Claimed task (${reason})`);
    }

    return claimed;
  });
}

/**
 * Race-safe task unclaim.
 */
export async function unclaimTaskLocked(
  cwd: string,
  taskId: string,
  agent: string
): Promise<SwarmTask | null> {
  return await withTaskLock(cwd, taskId, async () => {
    const task = store.getTask(cwd, taskId);
    if (!task || task.status !== "in_progress") {
      return null;
    }
    if (task.claimed_by && task.claimed_by !== agent) {
      return null;
    }

    return store.updateTask(cwd, taskId, {
      status: "todo",
      claimed_by: undefined,
      claimed_at: undefined,
    });
  });
}

/**
 * Race-safe task completion.
 */
export async function completeTaskLocked(
  cwd: string,
  taskId: string,
  agent: string,
  summary: string,
  evidence?: SwarmTaskEvidence
): Promise<SwarmTask | null> {
  return await withTaskLock(cwd, taskId, async () => {
    const task = store.getTask(cwd, taskId);
    if (!task || task.status !== "in_progress") {
      return null;
    }
    if (task.claimed_by && task.claimed_by !== agent) {
      return null;
    }

    return store.updateTask(cwd, taskId, {
      status: "done",
      completed_by: agent,
      completed_at: new Date().toISOString(),
      summary,
      evidence,
    });
  });
}

/**
 * Race-safe task blocking.
 */
export async function blockTaskLocked(
  cwd: string,
  taskId: string,
  agent: string,
  reason: string
): Promise<SwarmTask | null> {
  return await withTaskLock(cwd, taskId, async () => {
    const task = store.getTask(cwd, taskId);
    if (!task) {
      return null;
    }
    if (task.status === "done") {
      return null;
    }
    if (task.status === "in_progress" && task.claimed_by && task.claimed_by !== agent) {
      return null;
    }

    return store.blockTask(cwd, taskId, agent, reason);
  });
}

/**
 * Race-safe task reset with optional cascade.
 * 
 * Uses batch locking to prevent deadlocks when resetting multiple tasks.
 */
export async function resetTaskLocked(
  cwd: string,
  taskId: string,
  cascade: boolean = false,
  timeoutMs?: number
): Promise<SwarmTask[]> {
  // First, determine all tasks to lock
  const tasksToReset: string[] = [taskId];
  
  if (cascade) {
    const dependents = store.getTransitiveDependents(cwd, taskId);
    for (const dep of dependents) {
      if (dep.status !== "todo") {
        tasksToReset.push(dep.id);
      }
    }
  }

  // Sort to ensure consistent lock ordering (prevents deadlock)
  tasksToReset.sort();

  // Acquire all locks atomically
  const locks: TaskLock[] = [];
  try {
    for (const id of tasksToReset) {
      const lock = await TaskLock.acquire(cwd, id, timeoutMs);
      locks.push(lock);
    }

    // All locks acquired - safe to reset
    const reset: SwarmTask[] = [];
    
    for (const id of tasksToReset) {
      // Re-check under lock
      const task = store.getTask(cwd, id);
      if (!task || task.status === "todo") continue;

      const updated = store.updateTask(cwd, id, {
        status: "todo",
        claimed_by: undefined,
        claimed_at: undefined,
        completed_by: undefined,
        completed_at: undefined,
        summary: undefined,
        evidence: undefined,
        blocked_reason: undefined,
      });

      if (updated) {
        reset.push(updated);
      }
    }

    return reset;
  } finally {
    // Release all locks (reverse order)
    for (let i = locks.length - 1; i >= 0; i--) {
      await locks[i].release();
    }
  }
}

/**
 * Race-safe task creation with ID allocation lock.
 * 
 * Uses a global lock on ID allocation to prevent duplicate task IDs.
 */
export async function createTaskLocked(
  cwd: string,
  input: {
    title: string;
    content?: string;
    dependsOn?: string[];
    createdBy?: string;
  }
): Promise<store.SwarmTask> {
  // Lock the ID allocation process itself
  const idLockPath = "__id_allocation__";
  
  return await withTaskLock(cwd, idLockPath, async () => {
    // Validate dependencies under lock
    if (input.dependsOn) {
      for (const depId of input.dependsOn) {
        if (!store.getTask(cwd, depId)) {
          throw new Error(`Dependency ${depId} not found`);
        }
      }
    }

    // Safe to create - no race on ID allocation
    return store.createTask(cwd, {
      title: input.title,
      content: input.content,
      dependsOn: input.dependsOn ?? [],
      createdBy: input.createdBy ?? "system",
    });
  });
}

// Re-export types from base store
export { SwarmTask, SwarmTaskEvidence } from "./types.js";
