import * as fs from "node:fs";
import * as path from "node:path";
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
  return path.join(cwd, ".pi", "messenger", "swarm");
}

export function getTasksDir(cwd: string): string {
  return path.join(getSwarmDir(cwd), "tasks");
}

export function getArchiveDir(cwd: string): string {
  return path.join(getSwarmDir(cwd), "archive");
}

function getBlocksDir(cwd: string): string {
  return path.join(getSwarmDir(cwd), "blocks");
}

function taskJsonPath(cwd: string, taskId: string): string {
  return path.join(getTasksDir(cwd), `${taskId}.json`);
}

function taskSpecPath(cwd: string, taskId: string): string {
  return path.join(getTasksDir(cwd), `${taskId}.md`);
}

function taskProgressPath(cwd: string, taskId: string): string {
  return path.join(getTasksDir(cwd), `${taskId}.progress.md`);
}

function taskBlockPath(cwd: string, taskId: string): string {
  return path.join(getBlocksDir(cwd), `${taskId}.md`);
}

function taskNumericId(taskId: string): number {
  const match = taskId.match(/(\d+)$/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number.parseInt(match[1], 10);
}

function normalizeTask(task: SwarmTask): SwarmTask {
  return {
    ...task,
    depends_on: Array.isArray(task.depends_on) ? task.depends_on : [],
    attempt_count: typeof task.attempt_count === "number" ? task.attempt_count : 0,
  };
}

function allocateTaskId(cwd: string): string {
  const tasksDir = getTasksDir(cwd);
  if (!fs.existsSync(tasksDir)) return "task-1";

  let max = 0;
  for (const file of fs.readdirSync(tasksDir)) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -5);
    max = Math.max(max, taskNumericId(id));
  }
  return `task-${max + 1}`;
}

export function getTask(cwd: string, taskId: string): SwarmTask | null {
  const raw = readJson<SwarmTask>(taskJsonPath(cwd, taskId));
  return raw ? normalizeTask(raw) : null;
}

export function getTasks(cwd: string): SwarmTask[] {
  const dir = getTasksDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const tasks: SwarmTask[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const raw = readJson<SwarmTask>(path.join(dir, file));
    if (raw) tasks.push(normalizeTask(raw));
  }

  return tasks.sort((a, b) => taskNumericId(a.id) - taskNumericId(b.id));
}

export function getSummary(cwd: string): SwarmSummary {
  const tasks = getTasks(cwd);
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

  return summary;
}

export function updateTask(cwd: string, taskId: string, updates: Partial<SwarmTask>): SwarmTask | null {
  const existing = getTask(cwd, taskId);
  if (!existing) return null;

  const updated: SwarmTask = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  writeJson(taskJsonPath(cwd, taskId), updated);
  return updated;
}

export function createTask(cwd: string, input: SwarmTaskCreateInput): SwarmTask {
  const id = allocateTaskId(cwd);
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
  };

  writeJson(taskJsonPath(cwd, id), task);
  writeText(taskSpecPath(cwd, id), input.content?.trim()
    ? `# ${input.title}\n\n${input.content.trim()}\n`
    : `# ${input.title}\n\n*Spec pending*\n`);

  return task;
}

export function deleteTask(cwd: string, taskId: string): boolean {
  const existing = getTask(cwd, taskId);
  if (!existing) return false;

  try { fs.unlinkSync(taskJsonPath(cwd, taskId)); } catch {}
  try { fs.unlinkSync(taskSpecPath(cwd, taskId)); } catch {}
  try { fs.unlinkSync(taskProgressPath(cwd, taskId)); } catch {}
  try { fs.unlinkSync(taskBlockPath(cwd, taskId)); } catch {}

  const tasks = getTasks(cwd);
  for (const task of tasks) {
    if (!task.depends_on.includes(taskId)) continue;
    updateTask(cwd, task.id, {
      depends_on: task.depends_on.filter(dep => dep !== taskId),
    });
  }

  return true;
}

export interface ArchiveDoneResult {
  archived: number;
  archivedIds: string[];
  archiveDir: string | null;
}

function archiveTasks(cwd: string, tasksToArchive: SwarmTask[]): ArchiveDoneResult {
  if (tasksToArchive.length === 0) {
    return { archived: 0, archivedIds: [], archiveDir: null };
  }

  const archivedIds = tasksToArchive.map(task => task.id);
  const archiveRunDir = path.join(getArchiveDir(cwd), new Date().toISOString().replace(/[:.]/g, "-"));
  const archiveTasksDir = path.join(archiveRunDir, "tasks");
  const archiveBlocksDir = path.join(archiveRunDir, "blocks");

  ensureDir(archiveTasksDir);

  for (const task of tasksToArchive) {
    moveFile(taskJsonPath(cwd, task.id), path.join(archiveTasksDir, `${task.id}.json`));
    moveFile(taskSpecPath(cwd, task.id), path.join(archiveTasksDir, `${task.id}.md`));
    moveFile(taskProgressPath(cwd, task.id), path.join(archiveTasksDir, `${task.id}.progress.md`));

    const blockSrc = taskBlockPath(cwd, task.id);
    if (fs.existsSync(blockSrc)) {
      ensureDir(archiveBlocksDir);
      moveFile(blockSrc, path.join(archiveBlocksDir, `${task.id}.md`));
    }
  }

  const archivedSet = new Set(archivedIds);
  for (const task of getTasks(cwd)) {
    if (!task.depends_on.some(dep => archivedSet.has(dep))) continue;
    updateTask(cwd, task.id, {
      depends_on: task.depends_on.filter(dep => !archivedSet.has(dep)),
    });
  }

  return {
    archived: archivedIds.length,
    archivedIds,
    archiveDir: archiveRunDir,
  };
}

export function archiveDoneTasks(cwd: string): ArchiveDoneResult {
  const doneTasks = getTasks(cwd).filter(task => task.status === "done");
  return archiveTasks(cwd, doneTasks);
}

export function archiveTask(cwd: string, taskId: string): ArchiveDoneResult {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "done") {
    return { archived: 0, archivedIds: [], archiveDir: null };
  }
  return archiveTasks(cwd, [task]);
}

export function getTaskSpec(cwd: string, taskId: string): string | null {
  return readText(taskSpecPath(cwd, taskId));
}

export function setTaskSpec(cwd: string, taskId: string, content: string): void {
  writeText(taskSpecPath(cwd, taskId), content);
  updateTask(cwd, taskId, {});
}

export function appendTaskProgress(cwd: string, taskId: string, agent: string, message: string): void {
  const ts = new Date().toISOString();
  ensureDir(getTasksDir(cwd));
  fs.appendFileSync(taskProgressPath(cwd, taskId), `[${ts}] (${agent}) ${message}\n`);
}

export function getTaskProgress(cwd: string, taskId: string): string | null {
  const text = readText(taskProgressPath(cwd, taskId));
  if (!text || text.trim().length === 0) return null;
  return text;
}

export function getBlockContext(cwd: string, taskId: string): string | null {
  return readText(taskBlockPath(cwd, taskId));
}

export function getReadyTasks(cwd: string): SwarmTask[] {
  const tasks = getTasks(cwd);
  const doneIds = new Set(tasks.filter(task => task.status === "done").map(task => task.id));
  return tasks.filter(task => task.status === "todo" && task.depends_on.every(dep => doneIds.has(dep)));
}

export function claimTask(cwd: string, taskId: string, agent: string, reason?: string): SwarmTask | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "todo") return null;

  const readyIds = new Set(getReadyTasks(cwd).map(t => t.id));
  if (task.depends_on.length > 0 && !readyIds.has(taskId)) return null;

  const claimed = updateTask(cwd, taskId, {
    status: "in_progress",
    claimed_by: agent,
    claimed_at: new Date().toISOString(),
    blocked_reason: undefined,
    attempt_count: task.attempt_count + 1,
  });

  if (claimed && reason) {
    appendTaskProgress(cwd, taskId, agent, `Claimed task (${reason})`);
  }

  return claimed;
}

export function unclaimTask(cwd: string, taskId: string, agent: string): SwarmTask | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "in_progress") return null;
  if (task.claimed_by && task.claimed_by !== agent) return null;

  return updateTask(cwd, taskId, {
    status: "todo",
    claimed_by: undefined,
    claimed_at: undefined,
  });
}

export function completeTask(
  cwd: string,
  taskId: string,
  agent: string,
  summary: string,
  evidence?: SwarmTaskEvidence,
): SwarmTask | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "in_progress") return null;
  if (task.claimed_by && task.claimed_by !== agent) return null;

  return updateTask(cwd, taskId, {
    status: "done",
    completed_by: agent,
    completed_at: new Date().toISOString(),
    summary,
    evidence,
  });
}

export function blockTask(cwd: string, taskId: string, agent: string, reason: string): SwarmTask | null {
  const task = getTask(cwd, taskId);
  if (!task) return null;
  if (task.status === "done") return null;
  if (task.status === "in_progress" && task.claimed_by && task.claimed_by !== agent) return null;

  writeText(taskBlockPath(cwd, taskId), `# Blocked: ${task.title}\n\n**Reason:** ${reason}\n\n**Blocked at:** ${new Date().toISOString()}\n`);

  return updateTask(cwd, taskId, {
    status: "blocked",
    blocked_reason: reason,
    claimed_by: undefined,
    claimed_at: undefined,
  });
}

export function unblockTask(cwd: string, taskId: string): SwarmTask | null {
  const task = getTask(cwd, taskId);
  if (!task || task.status !== "blocked") return null;

  try { fs.unlinkSync(taskBlockPath(cwd, taskId)); } catch {}

  return updateTask(cwd, taskId, {
    status: "todo",
    blocked_reason: undefined,
  });
}

export function resetTask(cwd: string, taskId: string, cascade: boolean = false): SwarmTask[] {
  const task = getTask(cwd, taskId);
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
  });
  if (base) reset.push(base);

  try { fs.unlinkSync(taskBlockPath(cwd, taskId)); } catch {}

  if (cascade) {
    for (const dependent of getTransitiveDependents(cwd, taskId)) {
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
      });
      if (updated) reset.push(updated);
      try { fs.unlinkSync(taskBlockPath(cwd, dependent.id)); } catch {}
    }
  }

  return reset;
}

export function startTask(cwd: string, taskId: string, agent: string): SwarmTask | null {
  return claimTask(cwd, taskId, agent);
}

export function stopTask(cwd: string, taskId: string, agent: string): SwarmTask | null {
  return unclaimTask(cwd, taskId, agent);
}

export function getTransitiveDependents(cwd: string, rootId: string): SwarmTask[] {
  const tasks = getTasks(cwd);
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

export function hasAnyTasks(cwd: string): boolean {
  return getTasks(cwd).length > 0;
}

export function agentHasClaimedTask(cwd: string, agentName: string): boolean {
  return getTasks(cwd).some(task => task.status === "in_progress" && task.claimed_by === agentName);
}
