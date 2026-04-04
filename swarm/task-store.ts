import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeChannelId } from '../channel.js';
import type { SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence, SwarmSummary } from './types.js';

// =============================================================================
// Task Event Sourcing - Session-scoped JSONL
// =============================================================================

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'released'
  | 'progress'
  | 'completed'
  | 'blocked'
  | 'unblocked'
  | 'reset'
  | 'archived';

export interface TaskEvent {
  taskId: string;
  type: TaskEventType;
  timestamp: string;
  agent?: string; // Who performed the action
  channel?: string; // Original channel (for reference)
  payload?: unknown; // Type-specific data
}

// Event payloads
export interface CreatedPayload {
  title: string;
  content?: string;
  dependsOn?: string[];
  createdBy?: string;
}

export interface ClaimedPayload {
  previousAgent?: string;
  reason?: string;
}

export interface ProgressPayload {
  message: string;
  tokens?: number;
  toolCalls?: number;
}

export interface CompletedPayload {
  summary: string;
  evidence?: SwarmTaskEvidence;
}

export interface BlockedPayload {
  reason: string;
  blockedBy?: string;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getTasksJsonlPath(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'tasks', `${safeSessionId}.jsonl`);
}

function getTaskSpecsDir(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'tasks', safeSessionId);
}

function taskSpecPath(cwd: string, sessionId: string, taskId: string): string {
  return path.join(getTaskSpecsDir(cwd, sessionId), `${taskId}.md`);
}

function getLocksDir(cwd: string): string {
  return path.join(cwd, '.pi', 'messenger', 'locks');
}

function taskLockPath(cwd: string, taskId: string): string {
  return path.join(getLocksDir(cwd), `${taskId}.lock`);
}

/**
 * Append a task event to the session's JSONL log.
 */
export function appendTaskEvent(cwd: string, sessionId: string, event: TaskEvent): void {
  const filePath = getTasksJsonlPath(cwd, sessionId);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/**
 * Replay all events to build current task states.
 * Events are applied in order per taskId, with later events overriding earlier state.
 */
export function replayTasks(cwd: string, sessionId: string): SwarmTask[] {
  const filePath = getTasksJsonlPath(cwd, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const tasksById = new Map<string, SwarmTask>();

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TaskEvent;
      const existing = tasksById.get(event.taskId);

      switch (event.type) {
        case 'created': {
          const payload = event.payload as CreatedPayload;
          const task: SwarmTask = {
            id: event.taskId,
            title: payload.title,
            status: 'todo',
            depends_on: payload.dependsOn ?? [],
            created_at: event.timestamp,
            updated_at: event.timestamp,
            created_by: payload.createdBy,
            attempt_count: 0,
            channel: event.channel,
          };
          tasksById.set(event.taskId, task);
          break;
        }

        case 'claimed': {
          if (!existing) continue;
          const payload = event.payload as ClaimedPayload;
          existing.status = 'in_progress';
          existing.claimed_by = event.agent;
          existing.claimed_at = event.timestamp;
          existing.claim_reason = payload.reason;
          existing.attempt_count = (existing.attempt_count ?? 0) + 1;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'released': {
          if (!existing) continue;
          existing.status = 'todo';
          delete existing.claimed_by;
          delete existing.claimed_at;
          delete existing.claim_reason;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'progress': {
          if (!existing) continue;
          // Progress events don't change status, just log activity
          existing.updated_at = event.timestamp;
          // Could store progress log in a separate array if needed
          break;
        }

        case 'completed': {
          if (!existing) continue;
          const payload = event.payload as CompletedPayload;
          existing.status = 'done';
          existing.completed_at = event.timestamp;
          existing.completed_by = event.agent;
          existing.summary = payload.summary;
          existing.evidence = payload.evidence;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'blocked': {
          if (!existing) continue;
          const payload = event.payload as BlockedPayload;
          existing.status = 'blocked';
          existing.blocked_reason = payload.reason;
          existing.blocked_by = payload.blockedBy;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'unblocked': {
          if (!existing) continue;
          // Return to previous status (todo if not claimed, in_progress if claimed)
          if (existing.claimed_by) {
            existing.status = 'in_progress';
          } else {
            existing.status = 'todo';
          }
          delete existing.blocked_reason;
          delete existing.blocked_by;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'reset': {
          if (!existing) continue;
          // Reset to initial state but preserve history
          existing.status = 'todo';
          delete existing.claimed_by;
          delete existing.claimed_at;
          delete existing.claim_reason;
          delete existing.completed_at;
          delete existing.completed_by;
          delete existing.summary;
          delete existing.evidence;
          delete existing.blocked_reason;
          delete existing.blocked_by;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'archived': {
          if (!existing) continue;
          existing.status = 'archived';
          existing.archived_at = event.timestamp;
          existing.updated_at = event.timestamp;
          break;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return Array.from(tasksById.values())
    .filter((t) => t.status !== 'archived') // Filter archived by default
    .sort((a, b) => taskNumericId(a.id) - taskNumericId(b.id));
}

/**
 * Get all tasks including archived ones.
 */
export function replayAllTasks(cwd: string, sessionId: string): SwarmTask[] {
  const filePath = getTasksJsonlPath(cwd, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const tasksById = new Map<string, SwarmTask>();

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TaskEvent;
      const existing = tasksById.get(event.taskId);

      switch (event.type) {
        case 'created': {
          const payload = event.payload as CreatedPayload;
          const task: SwarmTask = {
            id: event.taskId,
            title: payload.title,
            status: 'todo',
            depends_on: payload.dependsOn ?? [],
            created_at: event.timestamp,
            updated_at: event.timestamp,
            created_by: payload.createdBy,
            attempt_count: 0,
            channel: event.channel,
          };
          tasksById.set(event.taskId, task);
          break;
        }

        case 'claimed': {
          if (!existing) continue;
          const payload = event.payload as ClaimedPayload;
          existing.status = 'in_progress';
          existing.claimed_by = event.agent;
          existing.claimed_at = event.timestamp;
          existing.claim_reason = payload.reason;
          existing.attempt_count = (existing.attempt_count ?? 0) + 1;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'released': {
          if (!existing) continue;
          existing.status = 'todo';
          delete existing.claimed_by;
          delete existing.claimed_at;
          delete existing.claim_reason;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'progress': {
          if (!existing) continue;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'completed': {
          if (!existing) continue;
          const payload = event.payload as CompletedPayload;
          existing.status = 'done';
          existing.completed_at = event.timestamp;
          existing.completed_by = event.agent;
          existing.summary = payload.summary;
          existing.evidence = payload.evidence;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'blocked': {
          if (!existing) continue;
          const payload = event.payload as BlockedPayload;
          existing.status = 'blocked';
          existing.blocked_reason = payload.reason;
          existing.blocked_by = payload.blockedBy;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'unblocked': {
          if (!existing) continue;
          if (existing.claimed_by) {
            existing.status = 'in_progress';
          } else {
            existing.status = 'todo';
          }
          delete existing.blocked_reason;
          delete existing.blocked_by;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'reset': {
          if (!existing) continue;
          existing.status = 'todo';
          delete existing.claimed_by;
          delete existing.claimed_at;
          delete existing.claim_reason;
          delete existing.completed_at;
          delete existing.completed_by;
          delete existing.summary;
          delete existing.evidence;
          delete existing.blocked_reason;
          delete existing.blocked_by;
          existing.updated_at = event.timestamp;
          break;
        }

        case 'archived': {
          if (!existing) continue;
          existing.status = 'archived';
          existing.archived_at = event.timestamp;
          existing.updated_at = event.timestamp;
          break;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return Array.from(tasksById.values()).sort((a, b) => taskNumericId(a.id) - taskNumericId(b.id));
}

/**
 * Get event history for a specific task (for auditing).
 */
export function getTaskEventHistory(cwd: string, sessionId: string, taskId: string): TaskEvent[] {
  const filePath = getTasksJsonlPath(cwd, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const events: TaskEvent[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as TaskEvent;
      if (event.taskId === taskId) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

function taskNumericId(taskId: string): number {
  const match = taskId.match(/(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(match[1], 10);
}

// =============================================================================
// Task Operations (Event-sourced)
// =============================================================================

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

function allocateTaskId(cwd: string, sessionId: string): string {
  const tasks = replayAllTasks(cwd, sessionId);
  const maxId = tasks.reduce((max, t) => Math.max(max, taskNumericId(t.id)), 0);
  return `task-${maxId + 1}`;
}

export function createTask(
  cwd: string,
  sessionId: string,
  input: SwarmTaskCreateInput,
  channelId: string = input.channel ?? 'general'
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

  // Write spec file separately (not part of event log - it's the "source of truth" for description)
  const specPath = taskSpecPath(cwd, sessionId, id);
  ensureDir(path.dirname(specPath));
  fs.writeFileSync(
    specPath,
    input.content?.trim()
      ? `# ${input.title}\n\n${input.content.trim()}\n`
      : `# ${input.title}\n\n*Spec pending*\n`,
    'utf-8'
  );

  // Return the task as it now exists
  const tasks = replayTasks(cwd, sessionId);
  return tasks.find((t) => t.id === id)!;
}

export function getTasks(cwd: string, sessionId: string): SwarmTask[] {
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

  // Write lock file for cross-process safety
  const lockPath = taskLockPath(cwd, taskId);
  if (fs.existsSync(lockPath)) {
    // Check if lock is stale
    try {
      const lockContent = fs.readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(lockContent);
      const lockAge = Date.now() - new Date(lock.since).getTime();
      if (lockAge < 5 * 60 * 1000) {
        // 5 min timeout
        return null; // Lock held by another agent
      }
    } catch {
      // Malformed lock, proceed anyway
    }
  }

  ensureDir(path.dirname(lockPath));
  fs.writeFileSync(lockPath, JSON.stringify({ agent: agentName, since: new Date().toISOString() }));

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

  // Remove lock file
  try {
    fs.unlinkSync(taskLockPath(cwd, taskId));
  } catch {}

  // Append release event
  appendTaskEvent(cwd, sessionId, {
    taskId,
    type: 'released',
    timestamp: new Date().toISOString(),
    agent: agentName,
  });

  return getTask(cwd, sessionId, taskId);
}

export function releaseTaskIfHeld(
  cwd: string,
  sessionId: string,
  taskId: string,
  agentName: string
): boolean {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return false;
  if (task.claimed_by === agentName) {
    unclaimTask(cwd, sessionId, taskId, agentName);
    return true;
  }
  return false;
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

  // Remove lock file
  try {
    fs.unlinkSync(taskLockPath(cwd, taskId));
  } catch {}

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

  // Remove lock file
  try {
    fs.unlinkSync(taskLockPath(cwd, taskId));
  } catch {}

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
      try {
        fs.unlinkSync(taskLockPath(cwd, dependentId));
      } catch {}

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

  // Use replayAllTasks to get the archived task (getTask filters out archived)
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

  // Remove lock file
  try {
    fs.unlinkSync(taskLockPath(cwd, taskId));
  } catch {}

  // Remove spec file
  try {
    fs.unlinkSync(taskSpecPath(cwd, sessionId, taskId));
  } catch {}

  // Note: We don't delete from the event log - the task still exists in history
  // We just archive it to mark as deleted
  archiveTask(cwd, sessionId, taskId);

  return true;
}

export function getTaskSpec(cwd: string, sessionId: string, taskId: string): string | null {
  const path = taskSpecPath(cwd, sessionId, taskId);
  if (!fs.existsSync(path)) return null;
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function updateTaskSpec(
  cwd: string,
  sessionId: string,
  taskId: string,
  content: string
): boolean {
  const task = getTask(cwd, sessionId, taskId);
  if (!task) return false;

  const specPath = taskSpecPath(cwd, sessionId, taskId);
  ensureDir(path.dirname(specPath));
  fs.writeFileSync(specPath, content, 'utf-8');
  return true;
}

// =============================================================================
// Task Queries
// =============================================================================

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

export function cleanupStaleLocks(cwd: string, maxAgeMs: number = 5 * 60 * 1000): number {
  const locksDir = getLocksDir(cwd);
  if (!fs.existsSync(locksDir)) return 0;

  let cleaned = 0;
  const now = Date.now();

  for (const file of fs.readdirSync(locksDir)) {
    if (!file.endsWith('.lock')) continue;
    const lockPath = path.join(locksDir, file);
    try {
      const content = fs.readFileSync(lockPath, 'utf-8');
      const lock = JSON.parse(content);
      const age = now - new Date(lock.since).getTime();
      if (age > maxAgeMs) {
        fs.unlinkSync(lockPath);
        cleaned++;
      }
    } catch {
      // Malformed lock, remove it
      try {
        fs.unlinkSync(lockPath);
        cleaned++;
      } catch {}
    }
  }

  return cleaned;
}

/**
 * Get progress log for a task from progress events.
 */
export function getTaskProgress(cwd: string, sessionId: string, taskId: string): string | null {
  const history = getTaskEventHistory(cwd, sessionId, taskId);
  const progressEvents = history.filter((e) => e.type === 'progress');

  if (progressEvents.length === 0) return null;

  return progressEvents
    .map((e) => {
      const payload = e.payload as ProgressPayload;
      const timestamp = new Date(e.timestamp).toLocaleString();
      return `[${timestamp}] ${e.agent}: ${payload.message}`;
    })
    .join('\n');
}
