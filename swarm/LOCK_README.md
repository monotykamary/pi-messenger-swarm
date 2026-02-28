# File-Based Locking with `await using` for Swarm Coordination

This directory contains a **race-safe file locking mechanism** for the pi-messenger swarm system, using the TC39 Explicit Resource Management proposal (`await using`).

## The Problem

The original swarm store has **race conditions** because multiple agents can read and write task files simultaneously:

```typescript
// RACE CONDITION EXAMPLE:
// Two agents claim the same task simultaneously - BOTH SUCCEED!
const claimed1 = claimTask(cwd, "task-1", "agent-A"); // "Success!"
const claimed2 = claimTask(cwd, "task-1", "agent-B"); // "Success!" (WRONG!)
```

## The Solution: `await using` Locks

We use **advisory file locking** with automatic cleanup via `Symbol.asyncDispose`:

```typescript
// RACE-SAFE VERSION:
await using lock = await TaskLock.acquire(cwd, "task-1");
// ^ Exclusive access guaranteed

const task = getTask(cwd, "task-1");
if (task?.status === "todo") {
  updateTask(cwd, "task-1", { status: "in_progress", claimed_by: agent });
}

// Lock automatically released here - even on errors!
```

## Files

| File | Purpose |
|------|---------|
| `lock.ts` | Core locking mechanism with `TaskLock`, `withTaskLock`, `TaskLockBatch` |
| `store-locked.ts` | Race-safe versions of store operations (drop-in replacements) |
| `lock-example.ts` | Detailed examples and migration guide |
| `lock-types.d.ts` | TypeScript declarations for `Symbol.asyncDispose` |
| `LOCK_README.md` | This documentation |

## Quick Start

### 1. Basic Task Claim

```typescript
import { TaskLock } from "./swarm/lock.js";
import * as store from "./swarm/store.js";

async function safeClaim(cwd: string, taskId: string, agent: string) {
  await using lock = await TaskLock.acquire(cwd, taskId);
  
  // Exclusive access - no other agent can modify this task
  const task = store.getTask(cwd, taskId);
  if (task?.status === "todo") {
    return store.updateTask(cwd, taskId, {
      status: "in_progress",
      claimed_by: agent,
    });
  }
  return null;
  // Lock auto-released via Symbol.asyncDispose
}
```

### 2. Using Convenience Wrapper

```typescript
import { withTaskLock } from "./swarm/lock.js";

const claimed = await withTaskLock(cwd, "task-1", async () => {
  const task = store.getTask(cwd, "task-1");
  if (task?.status !== "todo") return null;
  
  return store.updateTask(cwd, "task-1", {
    status: "in_progress",
    claimed_by: agent,
  });
});
```

### 3. Using Pre-Built Locked Operations

```typescript
import * as locked from "./swarm/store-locked.js";

// These are all race-safe:
const claimed = await locked.claimTaskLocked(cwd, "task-1", agent);
const completed = await locked.completeTaskLocked(cwd, "task-1", agent, "Done!");
const reset = await locked.resetTaskLocked(cwd, "task-1", true); // cascade
```

### 4. Multiple Operations (Batch Lock)

```typescript
import { TaskLockBatch } from "./swarm/lock.js";

// Lock multiple tasks atomically (sorted to prevent deadlock)
await using batch = await TaskLockBatch.acquire(cwd, ["task-1", "task-2"]);

// Safe to modify both - other agents see consistent state
store.updateTask(cwd, "task-1", { status: "done" });
store.updateTask(cwd, "task-2", { status: "done" });

// Both locks released automatically
```

## How It Works

### Lock File Format

Locks are stored in `.pi/messenger/swarm/locks/{taskId}.lock`:

```
12345@1699999999999
  │      │
  │      └── Timestamp (for stale detection)
  └───────── Process ID (for detecting dead processes)
```

### Stale Lock Cleanup

Locks are automatically cleaned up when:
1. **Normal release**: `await using` scope ends
2. **Process death**: Lock holder's PID no longer exists
3. **Timeout**: Lock older than 2× timeout (10s default) is considered orphaned

### Error Safety

The `await using` pattern guarantees cleanup even on errors:

```typescript
try {
  await using lock = await TaskLock.acquire(cwd, "task-1");
  throw new Error("Something went wrong!");
} catch {
  // Lock is STILL released - no resource leak!
}
```

## Race Conditions Fixed

| Scenario | Original (Race) | With Locks |
|----------|-----------------|------------|
| Double claim | ❌ Both agents win | ✅ Only first wins |
| Duplicate task ID | ❌ Possible | ✅ ID allocation locked |
| Complete after unclaim | ❌ Orphaned completion | ✅ Blocked by lock |
| Reset while working | ❌ Work lost | ✅ Can't reset locked task |
| Crash while holding | ❌ Permanent lock | ✅ Auto-stale cleanup |
| Multi-task operations | ❌ Partial visibility | ✅ Atomic batch locks |

## API Reference

### `TaskLock.acquire(cwd, taskId, timeoutMs?)`

Acquire exclusive lock on a task. Blocks until acquired or timeout.

```typescript
await using lock = await TaskLock.acquire("/project", "task-1", 5000);
```

### `TaskLock.tryAcquire(cwd, taskId)`

Non-blocking lock acquisition. Returns `null` if already locked.

```typescript
const lock = TaskLock.tryAcquire("/project", "task-1");
if (!lock) {
  console.log("Task is busy");
  return;
}
await using _ = lock;
```

### `TaskLock.isLocked(cwd, taskId)`

Check if a task is currently locked.

```typescript
const busy = await TaskLock.isLocked("/project", "task-1");
```

### `withTaskLock(cwd, taskId, operation, timeoutMs?)`

Convenience wrapper for executing code under lock.

```typescript
const result = await withTaskLock("/project", "task-1", async () => {
  // Exclusive access here
  return modifyTask();
});
```

### `TaskLockBatch.acquire(cwd, taskIds, timeoutMs?)`

Acquire multiple locks atomically (sorted to prevent deadlock).

```typescript
await using batch = await TaskLockBatch.acquire("/project", ["task-1", "task-2"]);
// All locks held - safe to modify both
```

## Testing

Run the lock tests:

```bash
npm test tests/swarm/lock.test.ts
```

Tests cover:
- Basic lock acquisition/release
- `await using` automatic cleanup
- Lock contention and blocking
- Stale lock detection and cleanup
- Race condition prevention

## Migration from Original Store

### Before (race-prone):

```typescript
import * as store from "./swarm/store.js";

function claimTask(cwd, taskId, agent) {
  const task = store.getTask(cwd, taskId);
  if (task?.status !== "todo") return null;
  
  return store.updateTask(cwd, taskId, {
    status: "in_progress",
    claimed_by: agent,
  });
}
```

### After (race-safe):

```typescript
import * as locked from "./swarm/store-locked.js";

// Option 1: Use pre-built locked operations
const claimed = await locked.claimTaskLocked(cwd, taskId, agent);

// Option 2: Manual lock management
import { TaskLock } from "./swarm/lock.js";

async function claimTaskSafe(cwd, taskId, agent) {
  await using lock = await TaskLock.acquire(cwd, taskId);
  
  const task = store.getTask(cwd, taskId);
  if (task?.status !== "todo") return null;
  
  return store.updateTask(cwd, taskId, {
    status: "in_progress",
    claimed_by: agent,
  });
}
```

## Requirements

- **Node.js**: 18+ (for `Symbol.asyncDispose` polyfill or native support)
- **TypeScript**: 5.2+ (for `await using` syntax)
- **ES2022**: Target in tsconfig

## Why `await using`?

The `await using` keyword (TC39 proposal) provides:

1. **Automatic cleanup**: No `try/finally` boilerplate
2. **Error safety**: Cleanup runs even on exceptions
3. **Composability**: Multiple resources via `await using a = ..., b = ...`
4. **Readability**: Clear scope boundaries

```typescript
// Traditional approach (verbose):
const lock = await acquireLock();
try {
  await doWork();
} finally {
  await lock.release();
}

// await using (clean):
await using lock = await TaskLock.acquire(cwd, taskId);
await doWork();
// Auto-released
```

## License

MIT - Same as pi-messenger project
