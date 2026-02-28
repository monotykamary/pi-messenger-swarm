import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateMemorableName } from "../lib.js";
import { createProgress, parseJsonlLine, updateProgress } from "../crew/utils/progress.js";
import { removeLiveWorker, updateLiveWorker } from "../crew/live-progress.js";
import type { SpawnRequest, SpawnedAgent } from "./types.js";

interface SpawnRuntime {
  process: ChildProcess;
  record: SpawnedAgent;
  startMs: number;
  stopping: boolean;
}

const runtimes = new Map<string, SpawnRuntime>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, "..");

function spawnLiveKey(id: string): string {
  return `spawn-${id}`;
}

function buildPrompt(request: SpawnRequest): string {
  const lines: string[] = [
    "# Swarm Subagent Assignment",
    "",
    `Role: ${request.role}`,
  ];

  if (request.persona?.trim()) {
    lines.push(`Persona: ${request.persona.trim()}`);
  }

  lines.push("", "## Objective", request.objective.trim());

  if (request.context?.trim()) {
    lines.push("", "## Context", request.context.trim());
  }

  lines.push(
    "",
    "## Operating Protocol",
    "1. Call pi_messenger({ action: \"join\" }) first.",
    "2. Coordinate via pi_messenger messaging/reservations/task tools.",
    "3. Keep updates concise and evidence-based.",
    "4. Use read/edit/write/bash tools as needed.",
  );

  if (request.taskId) {
    lines.push(
      "",
      "## Task",
      `You are assigned to ${request.taskId}.`,
      `Try to claim it first: pi_messenger({ action: \"task.claim\", id: \"${request.taskId}\" }).`,
      "If claim fails, report conflict and stop.",
      `When done, complete it: pi_messenger({ action: \"task.done\", id: \"${request.taskId}\", summary: \"...\" }).`,
    );
  }

  lines.push(
    "",
    "## Definition of Done",
    "- Objective addressed with concrete output.",
    "- Progress logged via pi_messenger where relevant.",
    "- Any file reservations released before exit.",
  );

  return lines.join("\n");
}

function applyModelArgs(args: string[], model?: string): void {
  if (!model) return;
  const slash = model.indexOf("/");
  if (slash !== -1) {
    args.push("--provider", model.slice(0, slash), "--model", model.slice(slash + 1));
    return;
  }
  args.push("--model", model);
}

function upsertSpawnRecord(id: string, updater: (record: SpawnedAgent) => SpawnedAgent): SpawnedAgent | null {
  const runtime = runtimes.get(id);
  if (!runtime) return null;
  runtime.record = updater(runtime.record);
  return runtime.record;
}

export function spawnSubagent(cwd: string, request: SpawnRequest): SpawnedAgent {
  const id = randomUUID().slice(0, 8);
  const name = request.name?.trim() || generateMemorableName();
  const startedAt = new Date().toISOString();

  const record: SpawnedAgent = {
    id,
    cwd,
    name,
    role: request.role,
    persona: request.persona,
    objective: request.objective,
    context: request.context,
    taskId: request.taskId,
    model: request.model,
    status: "running",
    startedAt,
  };

  const prompt = buildPrompt(request);

  const args = ["--mode", "json", "--no-session", "-p"];
  applyModelArgs(args, request.model);
  args.push("--extension", EXTENSION_DIR);
  args.push(prompt);

  const env = {
    ...process.env,
    PI_AGENT_NAME: name,
    PI_SWARM_SPAWNED: "1",
  };

  const proc = spawn("pi", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const progress = createProgress(name);
  const startMs = Date.now();
  let buffer = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer | string) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (!event) continue;
      updateProgress(progress, event, startMs);
      updateLiveWorker(cwd, record.taskId || spawnLiveKey(id), {
        taskId: record.taskId || spawnLiveKey(id),
        agent: "swarm-subagent",
        name,
        progress: {
          ...progress,
          recentTools: progress.recentTools.map(tool => ({ ...tool })),
        },
        startedAt: startMs,
      });
    }
  });

  proc.stderr?.on("data", (data: Buffer | string) => {
    stderr += data.toString();
  });

  proc.on("close", (code) => {
    removeLiveWorker(cwd, record.taskId || spawnLiveKey(id));

    const runtime = runtimes.get(id);
    if (!runtime) return;

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent["status"] = "completed";

    if (runtime.stopping) {
      status = "stopped";
    } else if ((code ?? 1) !== 0) {
      status = "failed";
    }

    runtime.record = {
      ...runtime.record,
      status,
      endedAt,
      exitCode: code ?? 1,
      error: status === "failed" ? (stderr.trim() || progress.error || "subagent failed") : undefined,
    };
  });

  runtimes.set(id, {
    process: proc,
    record,
    startMs,
    stopping: false,
  });

  return record;
}

export function listSpawned(cwd?: string): SpawnedAgent[] {
  const records = Array.from(runtimes.values()).map(runtime => runtime.record);
  const filtered = cwd ? records.filter(record => record.cwd === cwd) : records;
  return filtered.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function stopSpawn(cwd: string, id: string): boolean {
  const runtime = runtimes.get(id);
  if (!runtime) return false;
  if (runtime.record.cwd !== cwd) return false;
  if (runtime.process.exitCode !== null) return false;

  runtime.stopping = true;
  runtime.process.kill("SIGTERM");
  setTimeout(() => {
    if (runtime.process.exitCode === null) {
      runtime.process.kill("SIGKILL");
    }
  }, 4000).unref();

  return true;
}

export function stopAllSpawned(cwd?: string): void {
  for (const [id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.process.exitCode !== null) continue;
    runtime.stopping = true;
    runtime.process.kill("SIGTERM");
    setTimeout(() => {
      const live = runtimes.get(id);
      if (!live) return;
      if (live.process.exitCode === null) {
        live.process.kill("SIGKILL");
      }
    }, 4000).unref();
  }
}

export function cleanupExitedSpawned(cwd?: string): number {
  let removed = 0;
  for (const [id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.process.exitCode === null) continue;
    if (runtime.record.status === "running") continue;

    const ageMs = runtime.record.endedAt ? Date.now() - Date.parse(runtime.record.endedAt) : 0;
    if (ageMs < 60_000) continue;

    runtimes.delete(id);
    removed++;
  }
  return removed;
}

export function getRunningSpawnCount(cwd?: string): number {
  let count = 0;
  for (const runtime of runtimes.values()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.process.exitCode === null && runtime.record.status === "running") count++;
  }
  return count;
}

export function getSpawnByTask(cwd: string, taskId: string): SpawnedAgent | null {
  for (const runtime of runtimes.values()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.taskId !== taskId) continue;
    return runtime.record;
  }
  return null;
}

export function clearSpawnStateForTests(): void {
  runtimes.clear();
}
