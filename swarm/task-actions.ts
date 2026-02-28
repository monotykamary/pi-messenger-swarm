import { logFeedEvent } from "../feed.js";
import * as store from "./store.js";
import type { SwarmTask } from "./types.js";

export type TaskAction = "start" | "block" | "unblock" | "reset" | "cascade-reset" | "delete" | "archive" | "stop";

export interface TaskActionOptions {
  isWorkerActive?: (taskId: string) => boolean;
}

export interface TaskActionResult {
  success: boolean;
  message: string;
  error?: string;
  task?: SwarmTask;
  resetTasks?: SwarmTask[];
  unmetDependencies?: string[];
}

export function executeTaskAction(
  cwd: string,
  action: TaskAction,
  taskId: string,
  agentName: string,
  reason?: string,
  options?: TaskActionOptions,
): TaskActionResult {
  const task = store.getTask(cwd, taskId);
  if (!task) return { success: false, error: "not_found", message: `Task ${taskId} not found` };

  switch (action) {
    case "start": {
      if (task.status === "in_progress" && task.claimed_by === agentName) {
        return { success: true, message: `Already claimed ${taskId}`, task };
      }
      if (task.status !== "todo") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not todo` };
      }

      const ready = new Set(store.getReadyTasks(cwd).map(t => t.id));
      if (task.depends_on.length > 0 && !ready.has(task.id)) {
        const done = new Set(store.getTasks(cwd).filter(t => t.status === "done").map(t => t.id));
        const unmet = task.depends_on.filter(dep => !done.has(dep));
        return {
          success: false,
          error: "unmet_dependencies",
          message: `Unmet dependencies: ${unmet.join(", ")}`,
          unmetDependencies: unmet,
        };
      }

      const claimed = store.claimTask(cwd, taskId, agentName, reason);
      if (!claimed) return { success: false, error: "claim_failed", message: `Failed to claim ${taskId}` };
      logFeedEvent(cwd, agentName, "task.start", taskId, claimed.title);
      return { success: true, message: `Claimed ${taskId}`, task: claimed };
    }

    case "block": {
      if (!reason) {
        return { success: false, error: "missing_reason", message: `Reason required to block ${taskId}` };
      }
      const blocked = store.blockTask(cwd, taskId, agentName, reason);
      if (!blocked) return { success: false, error: "block_failed", message: `Failed to block ${taskId}` };
      logFeedEvent(cwd, agentName, "task.block", taskId, reason);
      return { success: true, message: `Blocked ${taskId}`, task: blocked };
    }

    case "unblock": {
      const unblocked = store.unblockTask(cwd, taskId);
      if (!unblocked) return { success: false, error: "unblock_failed", message: `Failed to unblock ${taskId}` };
      logFeedEvent(cwd, agentName, "task.unblock", taskId, unblocked.title);
      return { success: true, message: `Unblocked ${taskId}`, task: unblocked };
    }

    case "reset": {
      const resetTasks = store.resetTask(cwd, taskId, false);
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, task.title);
      return { success: true, message: `Reset ${taskId}`, resetTasks };
    }

    case "cascade-reset": {
      const resetTasks = store.resetTask(cwd, taskId, true);
      if (resetTasks.length === 0) return { success: false, error: "reset_failed", message: `Failed to reset ${taskId}` };
      logFeedEvent(cwd, agentName, "task.reset", taskId, `cascade (${resetTasks.length} tasks)`);
      return { success: true, message: `Reset ${taskId} + ${Math.max(0, resetTasks.length - 1)} dependents`, resetTasks };
    }

    case "delete": {
      if (task.status === "in_progress" && options?.isWorkerActive?.(taskId)) {
        return { success: false, error: "active_worker", message: `Cannot delete ${taskId} while its worker is active` };
      }
      if (!store.deleteTask(cwd, taskId)) {
        return { success: false, error: "delete_failed", message: `Failed to delete ${taskId}` };
      }
      logFeedEvent(cwd, agentName, "task.delete", taskId, task.title);
      return { success: true, message: `Deleted ${taskId}` };
    }

    case "archive": {
      if (task.status !== "done") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not done` };
      }
      const archived = store.archiveTask(cwd, taskId);
      if (archived.archived !== 1) {
        return { success: false, error: "archive_failed", message: `Failed to archive ${taskId}` };
      }
      logFeedEvent(cwd, agentName, "task.archive", taskId, task.title);
      return { success: true, message: `Archived ${taskId}` };
    }

    case "stop": {
      if (task.status !== "in_progress") {
        return { success: false, error: "invalid_status", message: `Task ${taskId} is ${task.status}, not in_progress` };
      }

      if (options?.isWorkerActive?.(taskId)) {
        store.appendTaskProgress(cwd, taskId, agentName, "Worker stop requested by user");
      }

      const unclaimed = store.unclaimTask(cwd, taskId, agentName);
      if (!unclaimed) {
        return { success: false, error: "stop_failed", message: `Failed to stop ${taskId}` };
      }
      logFeedEvent(cwd, agentName, "task.reset", taskId, "stopped");
      return { success: true, message: `Stopped ${taskId}`, task: unclaimed };
    }
  }
}
