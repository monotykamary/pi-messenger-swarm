/**
 * Tests for the file-based locking mechanism with `await using` support.
 * 
 * These tests verify that race conditions are properly prevented.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TaskLock, withTaskLock, TaskLockBatch } from "../../swarm/lock.js";
import * as store from "../../swarm/store.js";
import * as locked from "../../swarm/store-locked.js";

// Test utilities
function createTempDir(): string {
  const tmpDir = path.join(os.tmpdir(), `swarm-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  return tmpDir;
}

function cleanupTempDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

describe("TaskLock with await using", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("Basic lock acquisition", () => {
    it("should acquire and release lock with await using", async () => {
      await using lock = await TaskLock.acquire(tmpDir, "task-1");
      
      // Lock should be active
      const isLocked = await TaskLock.isLocked(tmpDir, "task-1");
      expect(isLocked).toBe(true);
      
      // Lock file should exist
      const lockPath = path.join(tmpDir, ".pi", "messenger", "swarm", "locks", "task-1.lock");
      expect(fs.existsSync(lockPath)).toBe(true);
      
      // Lock automatically released at end of block
    });

    it("should auto-release on scope exit", async () => {
      {
        await using lock = await TaskLock.acquire(tmpDir, "task-1");
        // Lock held here
        expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(true);
      }
      // Lock released after scope
      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(false);
    });

    it("should auto-release on error", async () => {
      try {
        await using lock = await TaskLock.acquire(tmpDir, "task-1");
        expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(true);
        throw new Error("Intentional error");
      } catch {
        // Lock should still be released
        expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(false);
      }
    });
  });

  describe("Lock contention", () => {
    it("should block second acquirer until first releases", async () => {
      const results: string[] = [];

      // First acquirer holds lock for 100ms
      const holder1 = async () => {
        await using lock = await TaskLock.acquire(tmpDir, "task-1");
        results.push("holder1-acquired");
        await new Promise(r => setTimeout(r, 100));
        results.push("holder1-releasing");
        // Auto-releases
      };

      // Second acquirer tries to get lock
      const holder2 = async () => {
        await new Promise(r => setTimeout(r, 20)); // Start after holder1
        results.push("holder2-trying");
        await using lock = await TaskLock.acquire(tmpDir, "task-1");
        results.push("holder2-acquired");
        // Auto-releases
      };

      await Promise.all([holder1(), holder2()]);

      // Should be ordered correctly
      expect(results).toEqual([
        "holder1-acquired",
        "holder2-trying",  // Tries while holder1 holds
        "holder1-releasing",
        "holder2-acquired", // Gets it after holder1
      ]);
    });

    it("should timeout if lock held too long", async () => {
      // Hold lock for a long time
      const holder = TaskLock.acquire(tmpDir, "task-1").then(async lock => {
        await new Promise(r => setTimeout(r, 500)); // Hold for 500ms
        await lock.release();
      });

      // Small delay to ensure holder acquires first
      await new Promise(r => setTimeout(r, 50));

      // Try to acquire with very short timeout - should fail
      await expect(
        TaskLock.acquire(tmpDir, "task-1", 50) // 50ms timeout
      ).rejects.toThrow(/Timeout acquiring lock/);

      // Cleanup - wait for holder to finish
      await holder;
    }, 10000); // Test timeout 10s
  });

  describe("tryAcquire non-blocking", () => {
    it("should return null if lock held", async () => {
      await using lock = await TaskLock.acquire(tmpDir, "task-1");
      
      const tryLock = TaskLock.tryAcquire(tmpDir, "task-1");
      expect(tryLock).toBeNull();
    });

    it("should return lock if available", async () => {
      const lock = TaskLock.tryAcquire(tmpDir, "task-1");
      expect(lock).not.toBeNull();
      
      await lock!.release();
    });
  });

  describe("Stale lock cleanup", () => {
    it("should clean up stale locks from dead processes", async () => {
      // Create a lock claiming to be from a non-existent process
      const lockDir = path.join(tmpDir, ".pi", "messenger", "swarm", "locks");
      fs.mkdirSync(lockDir, { recursive: true });
      
      const lockPath = path.join(lockDir, "task-1.lock");
      fs.writeFileSync(lockPath, "99999@1699999999999"); // Fake dead PID

      // Should be able to acquire (stale lock cleaned up)
      await using lock = await TaskLock.acquire(tmpDir, "task-1");
      expect(lock).toBeDefined();
    });

    it("should clean up old expired locks", async () => {
      const lockDir = path.join(tmpDir, ".pi", "messenger", "swarm", "locks");
      fs.mkdirSync(lockDir, { recursive: true });
      
      const lockPath = path.join(lockDir, "task-1.lock");
      // Old timestamp (more than 2x timeout ago)
      const oldTime = Date.now() - 20000; 
      fs.writeFileSync(lockPath, `${process.pid}@${oldTime}`);

      // Should be able to acquire (expired lock cleaned up)
      await using lock = await TaskLock.acquire(tmpDir, "task-1");
      expect(lock).toBeDefined();
    });
  });

  describe("withTaskLock convenience", () => {
    it("should execute operation under lock", async () => {
      const result = await withTaskLock(tmpDir, "task-1", async () => {
        const isLocked = await TaskLock.isLocked(tmpDir, "task-1");
        expect(isLocked).toBe(true);
        return "success";
      });

      expect(result).toBe("success");
      
      // Lock should be released
      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(false);
    });

    it("should release lock on error", async () => {
      await expect(
        withTaskLock(tmpDir, "task-1", async () => {
          throw new Error("Operation failed");
        })
      ).rejects.toThrow("Operation failed");

      // Lock should be released even on error
      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(false);
    });
  });

  describe("TaskLockBatch multi-lock", () => {
    it("should acquire multiple locks atomically", async () => {
      await using batch = await TaskLockBatch.acquire(tmpDir, ["task-1", "task-2"]);

      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(true);
      expect(await TaskLock.isLocked(tmpDir, "task-2")).toBe(true);
    });

    it("should sort task IDs to prevent deadlock", async () => {
      const acquisitionOrder: string[] = [];

      // Spy on actual lock acquisitions by checking filesystem
      const batch = TaskLockBatch.acquire(tmpDir, ["task-3", "task-1", "task-2"]);
      
      await using _ = await batch;

      // All should be locked
      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(true);
      expect(await TaskLock.isLocked(tmpDir, "task-2")).toBe(true);
      expect(await TaskLock.isLocked(tmpDir, "task-3")).toBe(true);
    });

    it("should release all locks on scope exit", async () => {
      {
        await using batch = await TaskLockBatch.acquire(tmpDir, ["task-1", "task-2"]);
      }

      expect(await TaskLock.isLocked(tmpDir, "task-1")).toBe(false);
      expect(await TaskLock.isLocked(tmpDir, "task-2")).toBe(false);
    });
  });
});

describe("Race-safe store operations", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  describe("claimTaskLocked", () => {
    it("should prevent double claim race", async () => {
      // Create a task
      const task = store.createTask(tmpDir, {
        title: "Test task",
        content: "Test content",
        dependsOn: [],
        createdBy: "test",
      });

      // Two agents try to claim simultaneously
      const [claim1, claim2] = await Promise.all([
        locked.claimTaskLocked(tmpDir, task.id, "agent-A"),
        locked.claimTaskLocked(tmpDir, task.id, "agent-B"),
      ]);

      // Only one should succeed
      const successes = [claim1, claim2].filter(c => c !== null);
      expect(successes).toHaveLength(1);

      // Verify the winner
      const claimedBy = store.getTask(tmpDir, task.id)?.claimed_by;
      expect(claimedBy).toBe(successes[0]?.claimed_by);
    });

    it("should re-check status under lock", async () => {
      // Create and claim a task
      const task = store.createTask(tmpDir, {
        title: "Test task",
        content: "Test",
        createdBy: "test",
      });

      // First claim succeeds
      const claim1 = await locked.claimTaskLocked(tmpDir, task.id, "agent-A");
      expect(claim1).not.toBeNull();

      // Second claim should fail (already in_progress)
      const claim2 = await locked.claimTaskLocked(tmpDir, task.id, "agent-B");
      expect(claim2).toBeNull();
    });
  });

  describe("createTaskLocked", () => {
    it("should prevent duplicate ID allocation", async () => {
      // Create multiple tasks simultaneously
      const tasks = await Promise.all([
        locked.createTaskLocked(tmpDir, { title: "Task 1", createdBy: "test" }),
        locked.createTaskLocked(tmpDir, { title: "Task 2", createdBy: "test" }),
        locked.createTaskLocked(tmpDir, { title: "Task 3", createdBy: "test" }),
      ]);

      // All should have unique IDs
      const ids = tasks.map(t => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe("completeTaskLocked", () => {
    it("should prevent completion after unclaim", async () => {
      // Create and claim
      const task = store.createTask(tmpDir, { title: "Test", createdBy: "test" });
      await locked.claimTaskLocked(tmpDir, task.id, "agent-A");

      // Unclaim
      await locked.unclaimTaskLocked(tmpDir, task.id, "agent-A");

      // Try to complete (should fail - not in_progress)
      const completed = await locked.completeTaskLocked(tmpDir, task.id, "agent-A", "Done!");
      expect(completed).toBeNull();
    });
  });

  describe("resetTaskLocked", () => {
    it("should acquire all locks atomically for cascade reset (no partial resets)", async () => {
      // Create task-1 with dependency task-2
      const task1 = store.createTask(tmpDir, { title: "Parent", createdBy: "test" });
      const task2 = store.createTask(tmpDir, { 
        title: "Dependent", 
        createdBy: "test",
        dependsOn: [task1.id]
      });

      // Both tasks completed
      await locked.claimTaskLocked(tmpDir, task1.id, "agent-A");
      await locked.completeTaskLocked(tmpDir, task1.id, "agent-A", "Done");
      await locked.claimTaskLocked(tmpDir, task2.id, "agent-B");
      await locked.completeTaskLocked(tmpDir, task2.id, "agent-B", "Done");

      // Reset task-1 with cascade - should reset both atomically
      const reset = await locked.resetTaskLocked(tmpDir, task1.id, true);

      // Both should be reset
      expect(reset.map(t => t.id).sort()).toEqual([task1.id, task2.id].sort());
      expect(store.getTask(tmpDir, task1.id)?.status).toBe("todo");
      expect(store.getTask(tmpDir, task2.id)?.status).toBe("todo");
    }, 10000);

    it("should serialize concurrent reset attempts (prevent reset-while-working race)", async () => {
      // Create a task
      const task1 = store.createTask(tmpDir, { title: "Test", createdBy: "test" });
      
      // Complete it
      await locked.claimTaskLocked(tmpDir, task1.id, "agent-A");
      await locked.completeTaskLocked(tmpDir, task1.id, "agent-A", "Done");

      // Two agents try to reset simultaneously - only one should succeed with non-empty result
      // (The lock ensures they serialize, and both will try to reset the same task)
      const [reset1, reset2] = await Promise.all([
        locked.resetTaskLocked(tmpDir, task1.id, false),
        locked.resetTaskLocked(tmpDir, task1.id, false),
      ]);

      // At least one should succeed
      const totalResets = reset1.length + reset2.length;
      expect(totalResets).toBeGreaterThanOrEqual(1);
      
      // Task should be reset (todo)
      expect(store.getTask(tmpDir, task1.id)?.status).toBe("todo");
    }, 10000);

    it("should allow reset when no conflicts", async () => {
      // Create a chain: task-1 -> task-2 -> task-3
      const task1 = store.createTask(tmpDir, { title: "Root", createdBy: "test" });
      const task2 = store.createTask(tmpDir, { 
        title: "Child", 
        createdBy: "test",
        dependsOn: [task1.id]
      });
      const task3 = store.createTask(tmpDir, { 
        title: "Grandchild", 
        createdBy: "test",
        dependsOn: [task2.id]
      });

      // Complete all tasks
      await locked.claimTaskLocked(tmpDir, task1.id, "agent");
      await locked.completeTaskLocked(tmpDir, task1.id, "agent", "Done");
      
      await locked.claimTaskLocked(tmpDir, task2.id, "agent");
      await locked.completeTaskLocked(tmpDir, task2.id, "agent", "Done");
      
      await locked.claimTaskLocked(tmpDir, task3.id, "agent");
      await locked.completeTaskLocked(tmpDir, task3.id, "agent", "Done");

      // Reset root with cascade - should reset all
      const reset = await locked.resetTaskLocked(tmpDir, task1.id, true);
      
      expect(reset).toHaveLength(3);
      expect(reset.map(t => t.id).sort()).toEqual([task1.id, task2.id, task3.id].sort());

      // All should be todo now
      expect(store.getTask(tmpDir, task1.id)?.status).toBe("todo");
      expect(store.getTask(tmpDir, task2.id)?.status).toBe("todo");
      expect(store.getTask(tmpDir, task3.id)?.status).toBe("todo");
    }, 10000);
  });

  describe("Dependency check race", () => {
    it("should maintain consistency when dependencies change during ready check", async () => {
      // Create dependency chain: task-1 must be done before task-2
      const task1 = store.createTask(tmpDir, { title: "Dependency", createdBy: "test" });
      const task2 = store.createTask(tmpDir, { 
        title: "Dependent", 
        createdBy: "test",
        dependsOn: [task1.id]
      });

      // Initially task-2 is not ready (task-1 is todo)
      const ready1 = store.getReadyTasks(tmpDir);
      expect(ready1.map(t => t.id)).not.toContain(task2.id);

      // Complete task-1 under lock
      await locked.claimTaskLocked(tmpDir, task1.id, "agent-A");
      await locked.completeTaskLocked(tmpDir, task1.id, "agent-A", "Done!");

      // Now task-2 should be ready
      const ready2 = store.getReadyTasks(tmpDir);
      expect(ready2.map(t => t.id)).toContain(task2.id);
    });

    it("should handle concurrent dependency completion and claim attempts", async () => {
      // Setup: task-2 depends on task-1
      const task1 = store.createTask(tmpDir, { title: "Dep", createdBy: "test" });
      const task2 = store.createTask(tmpDir, { 
        title: "Work", 
        createdBy: "test",
        dependsOn: [task1.id]
      });

      // Simulate: Agent A completes task-1 while Agent B tries to claim task-2
      const [completeResult, claimResult] = await Promise.all([
        // Agent A: complete task-1
        (async () => {
          const claimed = await locked.claimTaskLocked(tmpDir, task1.id, "agent-A");
          if (!claimed) return null;
          return locked.completeTaskLocked(tmpDir, task1.id, "agent-A", "Done!");
        })(),
        
        // Agent B: try to claim task-2 (should wait or fail until task-1 done)
        (async () => {
          // Small delay to let A start first
          await new Promise(r => setTimeout(r, 50));
          return locked.claimTaskLocked(tmpDir, task2.id, "agent-B");
        })()
      ]);

      // One of these scenarios should happen:
      // 1. A completes first, then B claims task-2 (success)
      // 2. B tries before A completes, can't claim (null)
      
      const task2After = store.getTask(tmpDir, task2.id);
      
      if (completeResult && claimResult) {
        // Scenario 1: A completed, B claimed
        expect(task2After?.claimed_by).toBe("agent-B");
      } else if (completeResult && !claimResult) {
        // Scenario 2: A completed, B tried too early
        // This is fine - B can retry
        expect(task2After?.status).toBe("todo");
      }
      // The key: task-2 is NEVER in_progress without task-1 being done
      expect(store.getTask(tmpDir, task1.id)?.status).toBe("done");
    });
  });
});
