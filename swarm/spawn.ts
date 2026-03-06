import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { generateMemorableName } from "../lib.js";
import { createProgress, parseJsonlLine, updateProgress } from "./progress.js";
import { removeLiveWorker, updateLiveWorker } from "./live-progress.js";
import type { SpawnRequest, SpawnedAgent } from "./types.js";
import { formatRoleLabel } from "./labels.js";

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

function buildSystemPrompt(request: SpawnRequest): string {
  const role = formatRoleLabel(request.role);
  const persona = request.persona?.trim();

  const lines: string[] = [
    "# Swarm Subagent Role",
    "",
    "## Role Description",
    `You are a specialized ${role} operating as an autonomous subagent inside a collaborative swarm.`,
  ];

  if (persona) {
    lines.push(`Persona: ${persona}`);
    lines.push("Stay consistent with this persona in tone, prioritization, and decision-making.");
  }

  lines.push(
    "",
    "## Mission Focus",
    request.objective.trim(),
  );

  if (request.context?.trim()) {
    lines.push("", "## Context & Constraints", request.context.trim());
  }

  if (request.taskId) {
    lines.push("", "## Assigned Task", `Primary task: ${request.taskId}`);
  }

  lines.push(
    "",
    "## Swarm Operating Protocol",
    '1. Join the mesh first: pi_messenger({ action: "join" }).',
    '2. Coordinate via messaging/reservations/task actions before risky edits.',
    '3. If assigned a task, try claim first and respect ownership conflicts.',
    '4. Report concrete progress and outcomes, not vague status.',
    '5. Be concise, evidence-based, and stay in role.',
    '6. Clarify ambiguity early: if mission scope, expected output format, or framing is unclear or seems incomplete, send a brief targeted question via pi_messenger({ action: "send", to: "AgentName", message: "..." }) before proceeding. A 30-second alignment check prevents off-target work.',
    '7. Exit when mission is complete: use bash({ command: "exit 0" }) to self-terminate. Do not stay alive indefinitely.',
  );

  return lines.join("\n");
}

function buildPrompt(request: SpawnRequest): string {
  const lines: string[] = [
    "# Mission Brief",
    "",
    request.objective.trim(),
  ];

  if (request.context?.trim()) {
    lines.push("", "## Additional Context", request.context.trim());
  }

  if (request.taskId) {
    lines.push(
      "",
      "## Task Execution",
      `Try to claim ${request.taskId}: pi_messenger({ action: "task.claim", id: "${request.taskId}" }).`,
      "If claim fails, report the conflict and stop.",
      `When complete: pi_messenger({ action: "task.done", id: "${request.taskId}", summary: "..." }).`,
    );
  }

  lines.push(
    "",
    "## Definition of Done",
    "- Objective addressed with concrete output.",
    "- Progress logged via pi_messenger where relevant.",
    "- Any file reservations released before exit.",
    '- Exit with: bash({ command: "exit 0" })',
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

interface SpawnState {
  id: string;
  cwd: string;
  name: string;
  request: SpawnRequest;
  prompt: string;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  progress: ReturnType<typeof createProgress>;
  startMs: number;
  buffer: string;
  stderr: string;
  triedFallback: boolean;
}

function createArgs(state: SpawnState, includeModel: boolean): string[] {
  const args = ["--mode", "json", "--no-session"];
  if (includeModel && state.request.model) {
    applyModelArgs(args, state.request.model);
  }
  args.push("--extension", EXTENSION_DIR);

  if (state.systemPrompt.trim().length > 0) {
    const promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-subagent-"));
    const promptPath = path.join(promptTmpDir, `${state.name.replace(/[^\w.-]/g, "_")}-${state.id}.md`);
    fs.writeFileSync(promptPath, state.systemPrompt, { mode: 0o600 });
    args.push("--append-system-prompt", promptPath);
    // Store tmpdir on args for retrieval
    (args as any)._promptTmpDir = promptTmpDir;
  }

  args.push(state.prompt);
  return args;
}

function cleanupTmpDir(tmpDir: string | null) {
  if (!tmpDir) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

function attachHandlers(proc: ChildProcess, state: SpawnState, promptTmpDir: string | null) {
  proc.stdout?.on("data", (data: Buffer | string) => {
    state.buffer += data.toString();
    const lines = state.buffer.split("\n");
    state.buffer = lines.pop() ?? "";

    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (!event) continue;
      updateProgress(state.progress, event, state.startMs);
      updateLiveWorker(state.cwd, state.request.taskId || spawnLiveKey(state.id), {
        taskId: state.request.taskId || spawnLiveKey(state.id),
        agent: "swarm-subagent",
        name: state.name,
        progress: {
          ...state.progress,
          recentTools: state.progress.recentTools.map(tool => ({ ...tool })),
        },
        startedAt: state.startMs,
      });
    }
  });

  proc.stderr?.on("data", (data: Buffer | string) => {
    state.stderr += data.toString();
  });

  proc.on("error", () => {
    cleanupTmpDir(promptTmpDir);
  });

  proc.on("close", (code) => {
    // Check if this is a model-not-found error and we haven't tried fallback yet
    const isModelNotFound =
      !state.triedFallback &&
      state.request.model &&
      (code ?? 1) !== 0 &&
      state.stderr.includes("Model") &&
      state.stderr.includes("not found");

    if (isModelNotFound) {
      // Clean up and retry without model
      cleanupTmpDir(promptTmpDir);
      state.triedFallback = true;

      console.warn(`[spawn] Model "${state.request.model}" not found, using default model`);

      // Update the record to reflect no model (mutate in place so returned reference updates)
      const runtime = runtimes.get(state.id);
      if (runtime) {
        runtime.record.model = undefined;
      }

      // Retry without model
      const fallbackArgs = createArgs(state, false);
      const fallbackTmpDir = (fallbackArgs as any)._promptTmpDir as string | null;

      const fallbackProc = spawn("pi", fallbackArgs, {
        cwd: state.cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: state.env,
      });

      // Clear stderr for the new attempt
      state.stderr = "";

      // Attach handlers to the new process
      attachHandlers(fallbackProc, state, fallbackTmpDir);

      // Update runtime with new process
      if (runtime) {
        runtime.process = fallbackProc;
      }
      return;
    }

    // Normal cleanup and status update
    cleanupTmpDir(promptTmpDir);
    removeLiveWorker(state.cwd, state.request.taskId || spawnLiveKey(state.id));

    const runtime = runtimes.get(state.id);
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
      error: status === "failed" ? (state.stderr.trim() || state.progress.error || "subagent failed") : undefined,
    };
  });
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
  const systemPrompt = buildSystemPrompt(request);
  record.systemPrompt = systemPrompt;

  const env = {
    ...process.env,
    PI_AGENT_NAME: name,
    PI_SWARM_SPAWNED: "1",
  };

  const state: SpawnState = {
    id,
    cwd,
    name,
    request,
    prompt,
    systemPrompt,
    env,
    progress: createProgress(name),
    startMs: Date.now(),
    buffer: "",
    stderr: "",
    triedFallback: false,
  };

  // Initial spawn attempt with model
  const args = createArgs(state, true);
  const promptTmpDir = (args as any)._promptTmpDir as string | null;

  const proc = spawn("pi", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  attachHandlers(proc, state, promptTmpDir);

  runtimes.set(id, {
    process: proc,
    record,
    startMs: state.startMs,
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
