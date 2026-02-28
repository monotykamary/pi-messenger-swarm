/**
 * Examples demonstrating race-safe operations with `await using` locks.
 * 
 * This file shows:
 * 1. The race conditions in the original code
 * 2. How `await using` solves them elegantly
 * 3. Comparison of approaches
 */

import { TaskLock, withTaskLock, TaskLockBatch } from "./lock.js";
import * as locked from "./store-locked.js";
import * as store from "./store.js";

// ============================================================================
// EXAMPLE 1: Basic task claim with automatic cleanup
// ============================================================================

async function exampleBasicClaim(cwd: string, taskId: string, agent: string) {
  /**
   * RACE-PRONE VERSION (original):
   * 
   * Time  Agent A                    Agent B                    File
   * ----  -------------------------  -------------------------  -----------
   * t0    getTask() → todo                                      task-1.json
   * t1                               getTask() → todo            (still todo)
   * t2    updateTask() → claimed_by=A                          in_progress, A
   * t3                               updateTask() → claimed_by=B in_progress, B
   * t4    Returns "claimed!"         Returns "claimed!"         
   * 
   * Result: Both agents think they claimed it! Only B actually owns it.
   */
  const raceProne = store.claimTask(cwd, taskId, agent);

  /**
   * RACE-SAFE VERSION with `await using`:
   * 
   * The lock ensures exclusive access during the entire operation.
   * Automatically released at end of block - even if errors occur!
   */
  await using lock = await TaskLock.acquire(cwd, taskId);
  
  // Under exclusive lock - no other process can modify this task
  const task = store.getTask(cwd, taskId);
  if (task?.status === "todo") {
    const claimed = store.updateTask(cwd, taskId, {
      status: "in_progress",
      claimed_by: agent,
    });
    return claimed;
  }
  
  // Lock automatically released here via Symbol.asyncDispose
}

// ============================================================================
// EXAMPLE 2: Using withTaskLock convenience wrapper
// ============================================================================

async function exampleWithLock(cwd: string, agent: string) {
  /**
   * Clean functional approach - operation is wrapped in closure.
   * Lock acquired before, released after - automatically.
   */
  const claimed = await withTaskLock(cwd, "task-1", async () => {
    const task = store.getTask(cwd, "task-1");
    if (task?.status !== "todo") return null;
    
    return store.updateTask(cwd, "task-1", {
      status: "in_progress",
      claimed_by: agent,
    });
  });

  // Using the locked store functions (even cleaner):
  const claimed2 = await locked.claimTaskLocked(cwd, "task-1", agent, "urgent fix");
}

// ============================================================================
// EXAMPLE 3: Multiple locks without deadlock (sorted acquisition)
// ============================================================================

async function exampleMultiLock(cwd: string) {
  /**
   * RACE-PRONE: Updating multiple tasks without coordination
   * - No atomicity between task-1 and task-2 updates
   * - Other agents see partial state (task-1 done, task-2 not)
   */
  store.updateTask(cwd, "task-1", { status: "done" });
  store.updateTask(cwd, "task-2", { status: "done" });
  // Risk: Other agents see task-1 done but task-2 still in_progress

  /**
   * RACE-SAFE: Batch lock acquisition in sorted order
   * 
   * TaskLockBatch sorts task IDs before locking, preventing deadlock
   * when two agents try to acquire overlapping sets of locks.
   */
  await using batch = await TaskLockBatch.acquire(cwd, ["task-2", "task-1"]);
  // Locks acquired in sorted order: ["task-1", "task-2"]
  
  // Now safe to update both atomically
  store.updateTask(cwd, "task-1", { status: "done" });
  store.updateTask(cwd, "task-2", { status: "done" });
  // Both locks released automatically at end of scope
}

// ============================================================================
// EXAMPLE 4: Cascading reset with multiple locks
// ============================================================================

async function exampleCascadingReset(cwd: string, rootTaskId: string) {
  /**
   * Reset a task and all its dependents.
   * 
   * Without locks: Dependents could be claimed while we're resetting!
   * Time  Agent A (reset)            Agent B (claim)
   * t0    reset task-1 (root)
   * t1                               claim task-2 (dependent)
   * t2    reset task-2 (B's claim!)  
   * 
   * With locks: All affected tasks locked before any changes
   */
  const reset = await locked.resetTaskLocked(cwd, rootTaskId, true);
  console.log(`Reset ${reset.length} tasks: ${reset.map(t => t.id).join(", ")}`);
}

// ============================================================================
// EXAMPLE 5: Error handling with automatic cleanup
// ============================================================================

async function exampleErrorHandling(cwd: string, taskId: string) {
  /**
   * The beauty of `await using`: cleanup happens ALWAYS,
   * even if errors are thrown!
   */
  try {
    await using lock = await TaskLock.acquire(cwd, taskId);
    
    const task = store.getTask(cwd, taskId);
    if (!task) throw new Error("Task not found");
    
    // Do some work...
    store.updateTask(cwd, taskId, { status: "in_progress" });
    
    // Oops, something goes wrong!
    throw new Error("Network error during task processing");
    
  } catch (err) {
    console.error("Operation failed:", err);
    // Lock was STILL released automatically!
    // No resource leak even on error paths
  }
}

// ============================================================================
// EXAMPLE 6: Non-blocking try-lock pattern
// ============================================================================

async function exampleTryLock(cwd: string, agent: string) {
  /**
   * Try to acquire lock without blocking.
   * Useful for " opportunistic" operations.
   */
  const lock = TaskLock.tryAcquire(cwd, "task-1");
  
  if (!lock) {
    console.log("Task is busy, skipping...");
    return null;
  }
  
  // We got the lock! Use `await using` for cleanup
  await using _l = lock;
  
  // Do work...
  return store.updateTask(cwd, "task-1", { claimed_by: agent });
}

// ============================================================================
// EXAMPLE 7: Lock status checking (for UI/visibility)
// ============================================================================

async function exampleLockStatus(cwd: string) {
  const isLocked = await TaskLock.isLocked(cwd, "task-1");
  console.log(`Task-1 is ${isLocked ? "locked" : "available"}`);
  
  // Show lock owner for debugging
  const lockPath = "..."; // internal path
  const owner = TaskLock.readOwner(lockPath);
  console.log(`Locked by: ${owner}`); // e.g., "12345@1699999999999"
}

// ============================================================================
// EXAMPLE 8: Stale lock cleanup
// ============================================================================

async function exampleStaleLockHandling(cwd: string) {
  /**
   * Stale locks are automatically cleaned up:
   * 
   * 1. When a lock is found, the system checks if the owning process is alive
   * 2. If process is dead, lock is removed and new acquirer gets it
   * 3. If lock is too old (2x timeout), it's also considered stale
   * 
   * This handles crashes - agent dies while holding lock → lock auto-cleaned
   */
  
  // This will succeed even if there's a stale lock
  await using lock = await TaskLock.acquire(cwd, "task-1");
  // If previous holder crashed, their lock was cleaned up automatically
}

// ============================================================================
// COMPARISON TABLE
// ============================================================================

/**
 * | Scenario              | Original (Race-Prone) | With `await using`      |
 * |-----------------------|-------------------------|---------------------------|
 * | Double claim          | ✅ Both think they won  | ❌ Second waits/fails     |
 * | Duplicate task IDs    | ✅ Possible             | ❌ ID allocation locked   |
 * | Complete after unclaim| ✅ Orphaned completion  | ❌ Blocked by lock        |
 * | Reset while working   | ✅ Work lost            | ❌ Can't reset locked     |
 * | Crash while holding   | 🔶 Permanent lock       | ✅ Auto-stale cleanup     |
 * | Error cleanup         | 🔶 Manual finally{}     | ✅ Auto Symbol.dispose    |
 * | Multiple task ops     | 🔶 Partial visibility   | ✅ Atomic batch locks     |
 * | Code complexity       | 🔶 Error-prone          | ✅ Clean, declarative     |
 */

// ============================================================================
// MIGRATION GUIDE: Converting existing code
// ============================================================================

/**
 * BEFORE (race-prone):
 * ```typescript
 * function claimTask(cwd, taskId, agent) {
 *   const task = getTask(cwd, taskId);              // READ
 *   if (task.status !== "todo") return null;        // CHECK
 *   return updateTask(cwd, taskId, {               // WRITE
 *     status: "in_progress", 
 *     claimed_by: agent 
 *   });
 * }
 * ```
 * 
 * AFTER (race-safe):
 * ```typescript
 * async function claimTaskLocked(cwd, taskId, agent) {
 *   await using lock = await TaskLock.acquire(cwd, taskId);
 *   
 *   const task = getTask(cwd, taskId);              // READ (under lock)
 *   if (task.status !== "todo") return null;        // CHECK (under lock)
 *   return updateTask(cwd, taskId, {               // WRITE (under lock)
 *     status: "in_progress",
 *     claimed_by: agent
 *   });
 *   // Lock auto-released
 * }
 * ```
 * 
 * Key changes:
 * 1. Add `async` to function
 * 2. Wrap body with `await using lock = await TaskLock.acquire(cwd, taskId)`
 * 3. Re-check conditions inside lock (state may have changed!)
 * 4. Remove manual cleanup - `await using` handles it
 */
