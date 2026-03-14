import * as fs from "node:fs";
import * as path from "node:path";
import { isProcessAlive } from "../lib.js";
import { logFeedEvent } from "../feed.js";
import { normalizeChannelId } from "../channel.js";
import type { SwarmSummary, SwarmTask, SwarmTaskCreateInput, SwarmTaskEvidence } from "./types.js";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function writeJson(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function readText(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function writeText(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

function moveFile(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  ensureDir(path.dirname(dst));
  try {
    fs.renameSync(src, dst);
  } catch {
    fs.copyFileSync(src, dst);
    fs.unlinkSync(src);
  }
}

export function getSwarmDir(cwd: string): string {
  return path.join(cwd, ".pi", "messenger");
}

export function getTasksRootDir(cwd: string): string {
  return path.join(getSwarmDir(cwd), "tasks");
}

export function getTasksDir(cwd: string, channelId: string = "general"): string {
  return path.join(getTasksRootDir(cwd), normalizeChannelId(channelId));
}

export function getArchiveDir(cwd: string, channelId: string = "general"): string {
  return path.join(getSwarmDir(cwd), "archive", normalizeChannelId(channelId));
}

function getBlocksDir(cwd: string, channelId: string = "general"): string {
  return path.join(getTasksDir(cwd, channelId), "blocks");
}

function taskJsonPath(cwd: string, taskId: string, channelId: string = "general"): string {
  return path.join(getTasksDir(cwd, channelId), `${taskId}.json`);
}

function taskSpecPath(cwd: string, taskId: string, channelId: string = "general"): string {
  return path.join(getTasksDir(cwd, channelId), `${taskId}.md`);
}

function taskProgressPath(cwd: string, taskId: string, channelId: string = "general"): string {
  return path.join(getTasksDir(cwd, channelId), `${taskId}.progress.md`);
}

function taskBlockPath(cwd: string, taskId: string, channelId: string = "general"): string {
  return path.join(getBlocksDir(cwd, channelId), `${taskId}.md`);
}

function taskNumericId(taskId: string): number {
  const match = taskId.match(/(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(match[1], 10);
}

function normalizeTask(task: SwarmTask, channelId: string): SwarmTask {
  return {
    ...task,
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
    attempt_count: typeof task.attempt_count === "number" ? task.attempt_count : 0,
    channel: task.channel ?? normalizeChannelId(channelId),
  };
}

function allocateTaskId(cwd: string, channelId: string = "general"): string {
  const tasksDir = getTasksDir(cwd, channelId);
  if (!fs.existsSync(tasksDir)) return "task-1";

  let max = 0;
  for (const file of fs.readdirSync(tasksDir)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    max = Math.max(max, taskNumericId(id));
  }
  return `task-${max + 1}`;
}

export function getTask(cwd: string, taskId: string, channelId: string = "general"): SwarmTask | null {
  const raw = readJson<SwarmTask>(taskJsonPath(cwd, taskId, channelId));
  return raw ? normalizeTask(raw, channelId) : null;
}

function isAgentActive(cwd: string, agentName: string): boolean | null {
  const regPath = path.join(cwd, ".pi", "messenger", "registry", `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!reg.pid || !isProcessAlive(reg.pid)) return false;
    return true;
  } catch {
    return false;
  }
}

export function cleanupStaleTaskClaims(cwd: string, channelId: string = "general"): number {
  const registryDir = path.join(cwd, ".pi", "messenger", "registry");
  if (!fs.existsSync(registryDir)) return 0;

  const tasks = getTasks(cwd, channelId);
  let cleaned = 0;

  const knownAgents = fs.existsSync(registryDir)
    ? fs.readdirSync(registryDir).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5))
    : [];

  for (const task of tasks) {
    if (task.status !== "in_progress" || !task.claimed_by) continue;

    const active = isAgentActive(cwd, task.claimed_by);
    if (active === false) {
      unclaimTask(cwd, task.id, task.claimed_by, channelId);
      logFeedEvent(cwd, task.claimed_by, "task.reset", task.id, "agent crashed - task auto-unclaimed", channelId);
      cleaned++;
    } else if (active === null && knownAgents.length > 0) {
      unclaimTask(cwd, task.id, task.claimed_by, channelId);
      logFeedEvent(cwd, task.claimed_by, "task.reset", task.id, "agent left - task auto-unclaimed", channelId);
      cleaned++;
    }
  }

  return cleaned;
}

const lastCleanupTimes = new Map<string, number>();
const CLEANUP_THROTTLE_MS = 30_000;
const TASK_CACHE_TTL_MS = 100;

const taskCache = new Map<string, { expiresAt: number; tasks: SwarmTask[] }>();
const taskDerivedCache = new WeakMap<SwarmTask[], {
  summary?: SwarmSummary;
  readyTasks?: SwarmTask[];
  doneIds?: Set<string>;
}>();

function getTaskCacheKey(cwd: string, channelId: string): string {
  return `${cwd}:${normalizeChannelId(channelId)}`;
}

function getOrCreateTaskDerivedCache(tasks: SwarmTask[]): {
  summary?: SwarmSummary;
  readyTasks?: SwarmTask[];
  doneIds?: Set<string>;
} {
  let cache = taskDerivedCache.get(tasks);
  if (!cache) {
    cache = {};
    taskDerivedCache.set(tasks, cache);
  }
  return cache;
}

function invalidateTasksCache(cwd: string, channelId: string = "general"): void {
  taskCache.delete(getTaskCacheKey(cwd, channelId));
}

export function getTasks(cwd: string, channelId: string = "general"): SwarmTask[] {
  const normalizedChannel = normalizeChannelId(channelId);
  const dir = getTasksDir(cwd, normalizedChannel);
  if (!fs.existsSync(dir)) return [];

  const key = getTaskCacheKey(cwd, normalizedChannel);
  const now = Date.now();
  const cached = taskCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.tasks;
  }

  const lastCleanupTime = lastCleanupTimes.get(key) ?? 0;
  if (now - lastCleanupTime > CLEANUP_THROTTLE_MS) {
    lastCleanupTimes.set(key, now);
    cleanupStaleTaskClaims(cwd, normalizedChannel);
  }

  const tasks: SwarmTask[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = readJson<SwarmTask>(path.join(dir, file));
    if (raw) tasks.push(normalizeTask(raw, normalizedChannel));
  }

  const sortedTasks = tasks.sort((a, b) => taskNumericId(a.id) - taskNumericId(b.id));
  taskCache.set(key, {
    expiresAt: now + TASK_CACHE_TTL_MS,
    tasks: sortedTasks,
  });
  return sortedTasks;
}

export function getSummaryForTasks(tasks: SwarmTask[]): SwarmSummary {
  const derived = getOrCreateTaskDerivedCache(tasks);
  if (derived.summary) return derived.summary;

  const summary: SwarmSummary = {
    total: tasks.length,
    todo: 0,
    in_progress: 0,
    done: 0,
    blocked: 0,
  };

  for (const task of tasks) {
    summary[task.status] += 1;
  }

  derived.summary = summary;
  return summary;
}

export function getSummary(cwd: string, channelId: string = "general"): SwarmSummary {
  return getSummaryForTasks(getTasks(cwd, channelId));
}

export function updateTask(cwd: string, taskId: string, updates: Partial<SwarmTask>, channelId: string = "general"): SwarmTask | null {
  const existing = getTask(cwd, taskId, channelId);
  if (!existing) return null;

  const updated: SwarmTask = {
    ...existing,
    ...updates,
    channel: existing.channel ?? normalizeChannelId(channelId),
    updated_at: new Date().toISOString(),
  };

  writeJson(taskJsonPath(cwd, taskId, channelId), updated);
  invalidateTasksCache(cwd, channelId);
  return updated;
}

export function createTask(cwd: string, input: SwarmTaskCreateInput, channelId: string = input.channel ?? "general"): SwarmTask {
  const normalizedChannel = normalizeChannelId(channelId);
  const id = allocateTaskId(cwd, normalizedChannel);
  const now = new Date().toISOString();

  const task: SwarmTask = {
    id,
    title: input.title,
    status: "todo",
    depends_on: input.dependsOn ?? [],
    created_at: now,
    updated_at: now,
    created_by: input.createdBy,
    attempt_count: 0,
    channel: normalizedChannel,
  };

  writeJson(taskJsonPath(cwd, id, normalizedChannel), task);
  writeText(taskSpecPath(cwd, id, normalizedChannel), input.content?.trim()
    ? `# ${input.title}\n\n${input.content.trim()}\n`
    : `# ${input.title}\n\n*Spec pending*\n`);

  invalidateTasksCache(cwd, normalizedChannel);
  return task;
}

export function deleteTask(cwd: string, taskId: string, channelId: string = "general"): boolean {
  const existing = getTask(cwd, taskId, channelId);
  if (!existing) return false;

  try { fs.unlinkSync(taskJsonPath(cwd, taskId, channelId)); } catch {}
  try { fs.unlinkSync(taskSpecPath(cwd, taskId, channelId)); } catch {}
  try { fs.unlinkSync(taskProgressPath(cwd, taskId, channelId)); } catch {}
  try { fs.unlinkSync(taskBlockPath(cwd, taskId, channelId)); } catch {}

  const tasks = getTasks(cwd, channelId);
  for (const task of tasks) {
    if (!task.depends_on.includes(taskId)) continue;
    updateTask(cwd, task.id, {
      depends_on: task.depends_on.filter(dep => dep !== taskId),
    }, channelId);
  }

  invalidateTasksCache(cwd, channelId);
  return true;
}

export interface ArchiveDoneResult {
  archived: number;
  archivedIds: string[];
  archiveDir: string | null;
}

function archiveTasks(cwd: string, tasksToArchive: SwarmTask[], channelId: string = "general"): ArchiveDoneResult {
  if (tasksToArchive.length === 0) {
    return { archived: 0, archivedIds: [], archiveDir: null };
  }

  const archivedIds = tasksToArchive.map(task => task.id);
  const archiveRunDir = path.join(getArchiveDir(cwd, channelId), new Date().toISOString().replace(/[:.]/g, "-"));
  const archiveTasksDir = path.join(archiveRunDir, "tasks");
  const archiveBlocksDir = path.join(archiveRunDir, "blocks");

  ensureDir(archiveTasksDir);

  for (const task of tasksToArchive) {
    moveFile(taskJsonPath(cwd, task.id, channelId), path.join(archiveTasksDir, `${task.id}.json`));
    moveFile(taskSpecPath(cwd, task.id, channelId), path.join(archiveTasksDir, `${task.id}.md`));
    moveFile(taskProgressPath(cwd, task.id, channelId), path.join(archiveTasksDir, `${task.id}.progress.md`));

    const blockSrc = taskBlockPath(cwd, task.id, channelId);
    if (fs.existsSync(blockSrc)) {
      ensureDir(archiveBlocksDir);
      moveFile(blockSrc, path.join(archiveBlocksDir, `${task.id}.md`));
    }
  }

  invalidateTasksCache(cwd, channelId);

  const archivedSet = new Set(archivedIds);
  for (const task of getTasks(cwd, channelId)) {
    if (!task.depends_on.some(dep => archivedSet.has(dep))) continue;
    updateTask(cwd, task.id, {
      depends_on: task.depends_on.filter(dep => !archivedSet.has(dep)),
    }, channelId);
  }

  return {
    archived: archivedIds.length,
    archivedIds,
    archiveDir: archiveRunDir,
  };
}

export function archiveDoneTasks(cwd: string, channelId: string = "general"): ArchiveDoneResult {
  const doneTasks = getTasks(cwd, channelId).filter(task => task.status === "done");
  return archiveTasks(cwd, doneTasks, channelId);
}

export function archiveTask(cwd: string, taskId: string, channelId: string = "general"): ArchiveDoneResult {
  const task = getTask(cwd, taskId, channelId);
  if (!task || task.status !== "done") {
    return { archived: 0, archivedIds: [], archiveDir: null };
  }
  return archiveTasks(cwd, [task], channelId);
}

export function getTaskSpec(cwd: string, taskId: string, channelId: string = "general"): string | null {
  return readText(taskSpecPath(cwd, taskId, channelId));
}

export function setTaskSpec(cwd: string, taskId: string, content: string, channelId: string = "general"): void {
  writeText(taskSpecPath(cwd, taskId, channelId), content);
  updateTask(cwd, taskId, {}, channelId);
}

export function appendTaskProgress(cwd: string, taskId: string, agent: string, message: string, channelId: string = "general"): void {
  const ts = new Date().toISOString();
  ensureDir(getTasksDir(cwd, channelId));
  fs.appendFileSync(taskProgressPath(cwd, taskId, channelId), `[${ts}] (${agent}) ${message}\n`);
}

export function getTaskProgress(cwd: string, taskId: string, channelId: string = "general"): string | null {
  const text = readText(taskProgressPath(cwd, taskId, channelId));
  if (!text || text.trim().length === 0) return null;
  return text;
}

export function getBlockContext(cwd: string, taskId: string, channelId: string = "general"): string | null {
  return readText(taskBlockPath(cwd, taskId, channelId));
}

export function getReadyTasksForTasks(tasks: SwarmTask[]): SwarmTask[] {
  const derived = getOrCreateTaskDerivedCache(tasks);
  if (derived.readyTasks) return derived.readyTasks;

  const doneIds = derived.doneIds ?? new Set(tasks.filter(task => task.status === "done").map(task => task.id));
  derived.doneIds = doneIds;
  derived.readyTasks = tasks.filter(task => task.status === "todo" && task.depends_on.every(dep => doneIds.has(dep)));
  return derived.readyTasks;
}

export function getReadyTasks(cwd: string, channelId: string = "general"): SwarmTask[] {
  return getReadyTasksForTasks(getTasks(cwd, channelId));
}

export function claimTask(cwd: string, taskId: string, agent: string, reason?: string, channelId: string = "general"): SwarmTask | null {
  const task = getTask(cwd, taskId, channelId);
  if (!task || task.status !== "todo") return null;

  const readyIds = new Set(getReadyTasks(cwd, channelId).map(t => t.id));
  if (task.depends_on.length > 0 && !readyIds.has(taskId)) return null;

  const claimed = updateTask(cwd, taskId, {
    status: "in_progress",
    claimed_by: agent,
    claimed_at: new Date().toISOString(),
    blocked_reason: undefined,
    attempt_count: task.attempt_count + 1,
  }, channelId);

  if (claimed && reason) {
    appendTaskProgress(cwd, taskId, agent, `Claimed task (${reason})`, channelId);
  }

  return claimed;
}

export function unclaimTask(cwd: string, taskId: string, agent: string, channelId: string = "general"): SwarmTask | null {
  const task = getTask(cwd, taskId, channelId);
  if (!task || task.status !== "in_progress") return null;
  if (task.claimed_by && task.claimed_by !== agent) return null;

  return updateTask(cwd, taskId, {
    status: "todo",
    claimed_by: undefined,
    claimed_at: undefined,
  }, channelId);
}

export function completeTask(
  cwd: string,
  taskId: string,
  agent: string,
  summary: string,
  evidence?: SwarmTaskEvidence,
  channelId: string = "general",
): SwarmTask | null {
  const task = getTask(cwd, taskId, channelId);
  if (!task || task.status !== "in_progress") return null;
  if (task.claimed_by && task.claimed_by !== agent) return null;

  return updateTask(cwd, taskId, {
    status: "done",
    completed_by: agent,
    completed_at: new Date().toISOString(),
    summary,
    evidence,
  }, channelId);
}

export function blockTask(cwd: string, taskId: string, agent: string, reason: string, channelId: string = "general"): SwarmTask | null {
  const task = getTask(cwd, taskId, channelId);
  if (!task) return null;
  if (task.status === "done") return null;
  if (task.status === "in_progress" && task.claimed_by && task.claimed_by !== agent) return null;

  writeText(taskBlockPath(cwd, taskId, channelId), `# Blocked: ${task.title}\n\n**Reason:** ${reason}\n\n**Blocked at:** ${new Date().toISOString()}\n`);

  return updateTask(cwd, taskId, {
    status: "blocked",
    blocked_reason: reason,
    claimed_by: undefined,
    claimed_at: undefined,
  }, channelId);
}

export function unblockTask(cwd: string, taskId: string, channelId: string = "general"): SwarmTask | null {
  const task = getTask(cwd, taskId, channelId);
  if (!task || task.status !== "blocked") return null;

  try { fs.unlinkSync(taskBlockPath(cwd, taskId, channelId)); } catch {}

  return updateTask(cwd, taskId, {
    status: "todo",
    blocked_reason: undefined,
  }, channelId);
}

export function resetTask(cwd: string, taskId: string, cascade: boolean = false, channelId: string = "general"): SwarmTask[] {
  const task = getTask(cwd, taskId, channelId);
  if (!task) return [];

  const reset: SwarmTask[] = [];

  const base = updateTask(cwd, taskId, {
    status: "todo",
    claimed_by: undefined,
    claimed_at: undefined,
    completed_by: undefined,
    completed_at: undefined,
    summary: undefined,
    evidence: undefined,
    blocked_reason: undefined,
  }, channelId);
  if (base) reset.push(base);

  try { fs.unlinkSync(taskBlockPath(cwd, taskId, channelId)); } catch {}

  if (cascade) {
    for (const dependent of getTransitiveDependents(cwd, taskId, channelId)) {
      if (dependent.status === "todo") continue;
      const updated = updateTask(cwd, dependent.id, {
        status: "todo",
        claimed_by: undefined,
        claimed_at: undefined,
        completed_by: undefined,
        completed_at: undefined,
        summary: undefined,
        evidence: undefined,
        blocked_reason: undefined,
      }, channelId);
      if (updated) reset.push(updated);
      try { fs.unlinkSync(taskBlockPath(cwd, dependent.id, channelId)); } catch {}
    }
  }

  return reset;
}

export function startTask(cwd: string, taskId: string, agent: string, channelId: string = "general"): SwarmTask | null {
  return claimTask(cwd, taskId, agent, undefined, channelId);
}

export function stopTask(cwd: string, taskId: string, agent: string, channelId: string = "general"): SwarmTask | null {
  return unclaimTask(cwd, taskId, agent, channelId);
}

export function getTransitiveDependents(cwd: string, rootId: string, channelId: string = "general"): SwarmTask[] {
  const tasks = getTasks(cwd, channelId);
  const found = new Set<string>();
  const queue = [rootId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const task of tasks) {
      if (task.id === rootId || found.has(task.id)) continue;
      if (!task.depends_on.includes(current)) continue;
      found.add(task.id);
      queue.push(task.id);
    }
  }

  return tasks.filter(task => found.has(task.id));
}

export function hasAnyTasks(cwd: string, channelId: string = "general"): boolean {
  return getTasks(cwd, channelId).length > 0;
}

export function agentHasClaimedTask(cwd: string, agentName: string, channelId: string = "general"): boolean {
  return getTasks(cwd, channelId).some(task => task.status === "in_progress" && task.claimed_by === agentName);
}
