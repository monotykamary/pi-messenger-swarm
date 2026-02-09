import * as fs from "node:fs";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTempCrewDirs, type TempCrewDirs } from "../helpers/temp-dirs.js";
import { createMockContext } from "../helpers/mock-context.js";

function writeWorkerAgent(cwd: string): void {
  const filePath = path.join(cwd, ".pi", "agents", "crew-worker.md");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `---
name: crew-worker
description: Test worker
crewRole: worker
---
You are a worker.
`);
}

function createDirs(cwd: string) {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

describe("crew/graceful shutdown", () => {
  let dirs: TempCrewDirs;

  beforeEach(() => {
    dirs = createTempCrewDirs();
    vi.restoreAllMocks();
  });

  it("raceTimeout returns true when promise resolves before timeout and false on timeout", async () => {
    const { raceTimeout } = await import("../../crew/agents.js");

    const fast = raceTimeout(new Promise<void>(resolve => {
      setTimeout(resolve, 5);
    }), 100);
    const slow = raceTimeout(new Promise<void>(() => {}), 5);

    await expect(fast).resolves.toBe(true);
    await expect(slow).resolves.toBe(false);
  });

  it("abort signal writes shutdown inbox message and marks wasGracefullyShutdown", async () => {
    vi.resetModules();

    const spawnMock = vi.fn(() => {
      const proc = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter;
        stderr: EventEmitter;
        killed: boolean;
        exitCode: number | null;
        kill: (signal?: NodeJS.Signals) => boolean;
      };
      proc.pid = 4242;
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.killed = false;
      proc.exitCode = null;
      proc.kill = (signal?: NodeJS.Signals) => {
        proc.killed = true;
        proc.exitCode = signal === "SIGKILL" ? 137 : 143;
        queueMicrotask(() => {
          proc.emit("exit", proc.exitCode);
          proc.emit("close", proc.exitCode);
        });
        return true;
      };
      return proc;
    });

    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { spawnAgents } = await import("../../crew/agents.js");

    writeWorkerAgent(dirs.cwd);

    fs.writeFileSync(path.join(dirs.crewDir, "config.json"), JSON.stringify({
      work: {
        shutdownGracePeriodMs: 1,
      },
    }, null, 2));

    const messengerDirs = createDirs(dirs.cwd);
    const workerName = "worker-test";
    fs.mkdirSync(path.join(messengerDirs.inbox, workerName), { recursive: true });
    fs.writeFileSync(path.join(messengerDirs.registry, `${workerName}.json`), JSON.stringify({
      name: workerName,
      pid: 4242,
    }, null, 2));

    const controller = new AbortController();
    const resultPromise = spawnAgents([{
      agent: "crew-worker",
      task: "execute task",
      taskId: "task-1",
    }], 1, dirs.cwd, {
      signal: controller.signal,
      messengerDirs: { registry: messengerDirs.registry, inbox: messengerDirs.inbox },
    });

    controller.abort();
    const results = await resultPromise;

    expect(results).toHaveLength(1);
    expect(results[0].taskId).toBe("task-1");
    expect(results[0].wasGracefullyShutdown).toBe(true);
    expect(results[0].exitCode).toBe(143);

    const inboxFiles = fs.readdirSync(path.join(messengerDirs.inbox, workerName));
    expect(inboxFiles.some(f => f.endsWith("-shutdown.json"))).toBe(true);

    const shutdownFile = inboxFiles.find(f => f.endsWith("-shutdown.json"))!;
    const shutdownPayload = JSON.parse(
      fs.readFileSync(path.join(messengerDirs.inbox, workerName, shutdownFile), "utf-8")
    );
    expect(shutdownPayload.text).toContain("SHUTDOWN REQUESTED");
    expect(shutdownPayload.from).toBe("crew-orchestrator");

    expect(fs.existsSync(path.join(messengerDirs.registry, `${workerName}.json`))).toBe(false);
  });

  it("result processing uses taskId and graceful shutdown branches correctly", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 0,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "running" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const response = await workHandler.execute(
      { action: "work" },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );

    const reloaded = store.getTask(dirs.cwd, task.id);
    expect(reloaded?.status).toBe("todo");
    expect(reloaded?.assigned_to).toBeUndefined();
    expect(response.details.failed).toEqual([]);
    expect(response.details.blocked).toEqual([]);
  });

  it("graceful non-zero exit with done task is credited as success; crash blocks in autonomous mode", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const t1 = store.createTask(dirs.cwd, "Task one", "Desc one");
    const t2 = store.createTask(dirs.cwd, "Task two", "Desc two");

    let call = 0;
    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      call++;
      if (call === 1) {
        store.updateTask(dirs.cwd, t1.id, { status: "done" });
        return [{
          agent: "crew-worker",
          exitCode: 1,
          output: "",
          truncated: false,
          progress: {
            agent: "crew-worker",
            status: "failed" as const,
            recentTools: [],
            toolCallCount: 0,
            tokens: 0,
            durationMs: 0,
          },
          taskId: t1.id,
          wasGracefullyShutdown: true,
          error: "terminated",
        }];
      }

      store.updateTask(dirs.cwd, t2.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: t2.id,
        wasGracefullyShutdown: false,
        error: "crash",
      }];
    });

    const first = await workHandler.execute(
      { action: "work", concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(first.details.succeeded).toEqual([t1.id]);

    const second = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      () => {},
    );
    expect(second.details.blocked).toEqual([t2.id]);
    expect(store.getTask(dirs.cwd, t2.id)?.status).toBe("blocked");
  });

  it("autonomous mode stops with manual reason when signal is aborted", async () => {
    const store = await import("../../crew/store.js");
    const agents = await import("../../crew/agents.js");
    const workHandler = await import("../../crew/handlers/work.js");
    const state = await import("../../crew/state.js");

    state.autonomousState.active = false;
    state.autonomousState.cwd = null;
    state.autonomousState.waveNumber = 0;
    state.autonomousState.waveHistory = [];
    state.autonomousState.startedAt = null;
    state.autonomousState.stoppedAt = null;
    state.autonomousState.stopReason = null;

    writeWorkerAgent(dirs.cwd);
    store.createPlan(dirs.cwd, "docs/PRD.md");
    const task = store.createTask(dirs.cwd, "Task one", "Desc one");

    vi.spyOn(agents, "spawnAgents").mockImplementation(async () => {
      store.updateTask(dirs.cwd, task.id, { status: "in_progress", assigned_to: "crew-worker" });
      return [{
        agent: "crew-worker",
        exitCode: 1,
        output: "",
        truncated: false,
        progress: {
          agent: "crew-worker",
          status: "failed" as const,
          recentTools: [],
          toolCallCount: 0,
          tokens: 0,
          durationMs: 0,
        },
        taskId: task.id,
        wasGracefullyShutdown: true,
      }];
    });

    const controller = new AbortController();
    controller.abort();

    const appendEntry = vi.fn();
    const response = await workHandler.execute(
      { action: "work", autonomous: true, concurrency: 1 },
      createDirs(dirs.cwd),
      createMockContext(dirs.cwd),
      appendEntry,
      controller.signal,
    );

    expect(state.autonomousState.active).toBe(false);
    expect(state.autonomousState.stopReason).toBe("manual");
    expect(appendEntry).toHaveBeenCalledWith("crew-state", state.autonomousState);
    expect(response.content[0].text).toContain("Autonomous mode stopped (cancelled).");
  });
});
