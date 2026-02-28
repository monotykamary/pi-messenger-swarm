/**
 * File-based locking with `await using` support for swarm coordination.
 * 
 * Uses advisory lock files with automatic cleanup via Explicit Resource Management.
 * 
 * @example
 * ```typescript
 * // Lock a task for exclusive access
 * await using lock = await TaskLock.acquire(cwd, "task-1");
 * 
 * // Safe to read-modify-write
 * const task = getTask(cwd, "task-1");
 * if (task.status === "todo") {
 *   updateTask(cwd, "task-1", { status: "in_progress", claimed_by: agent });
 * }
 * // Lock automatically released here
 * ```
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOCK_TIMEOUT_MS = 5000;
const LOCK_RETRY_MS = 50;

/** Symbol for async disposable pattern */
declare global {
  interface SymbolConstructor {
    readonly asyncDispose: unique symbol;
  }
}

/**
 * A file-based lock that supports `await using` for automatic cleanup.
 * Implements the AsyncDisposable pattern (TC39 Explicit Resource Management).
 */
export class TaskLock implements AsyncDisposable {
  /** @internal */
  private constructor(
    private readonly lockPath: string,
    private readonly taskId: string,
    private released = false
  ) {}

  /**
   * Acquire an exclusive lock on a task.
   * Blocks until lock is acquired or timeout expires.
   * 
   * @param cwd Project directory
   * @param taskId Task to lock (e.g., "task-1")
   * @param timeoutMs Maximum time to wait for lock (default: 5000ms)
   * @returns TaskLock instance for use with `await using`
   * @throws Error if lock cannot be acquired within timeout
   */
  static async acquire(
    cwd: string,
    taskId: string,
    timeoutMs = LOCK_TIMEOUT_MS
  ): Promise<TaskLock> {
    const swarmDir = path.join(cwd, ".pi", "messenger", "swarm");
    const locksDir = path.join(swarmDir, "locks");
    
    // Ensure locks directory exists
    if (!fs.existsSync(locksDir)) {
      fs.mkdirSync(locksDir, { recursive: true });
    }

    const lockPath = path.join(locksDir, `${taskId}.lock`);
    const startTime = Date.now();
    const pid = process.pid;
    const ownerInfo = `${pid}@${Date.now()}`;

    while (true) {
      try {
        // Try to create lock file atomically with O_EXCL
        fs.writeFileSync(lockPath, ownerInfo, { flag: "wx" });
        
        // Lock acquired!
        return new TaskLock(lockPath, taskId, false);
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Lock exists, check if stale
          const isStale = await TaskLock.isStale(lockPath);
          
          if (isStale) {
            // Remove stale lock and retry immediately
            try {
              fs.unlinkSync(lockPath);
              continue;
            } catch {
              // Someone else removed it, retry
              continue;
            }
          }
          
          // Valid lock exists, wait and retry
          if (Date.now() - startTime > timeoutMs) {
            throw new Error(
              `Timeout acquiring lock for ${taskId}. ` +
              `Lock held by: ${TaskLock.readOwner(lockPath)}. ` +
              `Consider increasing timeout or checking for dead processes.`
            );
          }
          
          await TaskLock.sleep(LOCK_RETRY_MS);
          continue;
        }
        
        throw err;
      }
    }
  }

  /**
   * Try to acquire lock without blocking.
   * Returns null if lock is already held.
   * 
   * @param cwd Project directory
   * @param taskId Task to lock
   * @returns TaskLock if acquired, null otherwise
   */
  static tryAcquire(cwd: string, taskId: string): TaskLock | null {
    const swarmDir = path.join(cwd, ".pi", "messenger", "swarm");
    const locksDir = path.join(swarmDir, "locks");
    
    if (!fs.existsSync(locksDir)) {
      fs.mkdirSync(locksDir, { recursive: true });
    }

    const lockPath = path.join(locksDir, `${taskId}.lock`);
    const pid = process.pid;
    const ownerInfo = `${pid}@${Date.now()}`;

    try {
      fs.writeFileSync(lockPath, ownerInfo, { flag: "wx" });
      return new TaskLock(lockPath, taskId, false);
    } catch {
      return null;
    }
  }

  /**
   * Check if a task is currently locked (non-blocking).
   * Also cleans up stale locks automatically.
   */
  static async isLocked(cwd: string, taskId: string): Promise<boolean> {
    const lockPath = path.join(cwd, ".pi", "messenger", "swarm", "locks", `${taskId}.lock`);
    
    if (!fs.existsSync(lockPath)) {
      return false;
    }

    const isStale = await TaskLock.isStale(lockPath);
    if (isStale) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Race: someone else cleaned it up
      }
      return false;
    }

    return true;
  }

  /**
   * Get the owner of a lock (for debugging).
   */
  static readOwner(lockPath: string): string | null {
    try {
      return fs.readFileSync(lockPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * AsyncDisposable interface - called automatically by `await using`.
   * This is the magic that makes `await using` work!
   */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }

  /**
   * Manually release the lock (called automatically by `await using`).
   */
  async release(): Promise<void> {
    if (this.released) return;
    
    try {
      fs.unlinkSync(this.lockPath);
    } catch (err: any) {
      // Already released or race condition - not fatal
      if (err.code !== "ENOENT") {
        console.error(`[swarm] Warning: failed to release lock for ${this.taskId}:`, err.message);
      }
    } finally {
      this.released = true;
    }
  }

  /** @internal Check if lock is stale (process dead or timeout exceeded) */
  private static async isStale(lockPath: string): Promise<boolean> {
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const [pidStr, timestampStr] = content.split("@");
      const pid = parseInt(pidStr, 10);
      const timestamp = parseInt(timestampStr, 10);

      // Check if process is still alive
      const processAlive = TaskLock.isProcessAlive(pid);
      
      // Check if lock is too old (orphaned)
      const lockAge = Date.now() - timestamp;
      const lockExpired = lockAge > LOCK_TIMEOUT_MS * 2;

      return !processAlive || lockExpired;
    } catch {
      // Can't read lock file, assume it's stale
      return true;
    }
  }

  /** @internal Check if a process is still running */
  private static isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without affecting it
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** @internal */
  private static sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Convenience function for quick lock-protected operations.
 * 
 * @example
 * ```typescript
 * await withTaskLock(cwd, "task-1", async () => {
 *   const task = getTask(cwd, "task-1");
 *   if (task.status === "todo") {
 *     updateTask(cwd, "task-1", { status: "in_progress" });
 *   }
 * });
 * ```
 */
export async function withTaskLock<T>(
  cwd: string,
  taskId: string,
  operation: () => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  await using lock = await TaskLock.acquire(cwd, taskId, timeoutMs);
  return await operation();
}

/**
 * Batch lock acquisition for operations on multiple tasks.
 * Acquires locks in sorted order to prevent deadlocks.
 * 
 * @example
 * ```typescript
 * await using batch = await TaskLockBatch.acquire(cwd, ["task-1", "task-2"]);
 * // Safe to modify both tasks - locks acquired in sorted order
 * ```
 */
export class TaskLockBatch implements AsyncDisposable {
  private constructor(private readonly locks: TaskLock[]) {}

  static async acquire(cwd: string, taskIds: string[], timeoutMs?: number): Promise<TaskLockBatch> {
    // Sort to prevent deadlock (consistent lock ordering)
    const sorted = [...taskIds].sort();
    const locks: TaskLock[] = [];

    try {
      for (const taskId of sorted) {
        const lock = await TaskLock.acquire(cwd, taskId, timeoutMs);
        locks.push(lock);
      }
      return new TaskLockBatch(locks);
    } catch (err) {
      // Release any acquired locks on failure
      for (const lock of locks) {
        await lock.release();
      }
      throw err;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    // Release in reverse order
    for (let i = this.locks.length - 1; i >= 0; i--) {
      await this.locks[i].release();
    }
  }
}
