import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessengerState, Dirs } from "../../lib.js";
import { executeCrewAction } from "../../crew/index.js";
import { createMockContext } from "../helpers/mock-context.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-router-"));
  roots.add(cwd);
  return cwd;
}

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, ".pi", "messenger");
  const registry = path.join(base, "registry");
  const inbox = path.join(base, "inbox");
  fs.mkdirSync(registry, { recursive: true });
  fs.mkdirSync(inbox, { recursive: true });
  return { base, registry, inbox };
}

function createState(agentName: string): MessengerState {
  return {
    agentName,
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    broadcastHistory: [],
    seenSenders: new Map(),
    model: "test-model",
    gitBranch: "main",
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
  } as MessengerState;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

describe("swarm router", () => {
  it("supports task create/claim/done end-to-end", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentOne");
    const ctx = createMockContext(cwd);

    const created = await executeCrewAction(
      "task.create",
      { title: "Fix login timeout", content: "Adjust session keepalive" },
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    expect(created.content[0]?.text).toContain("Created task-1");

    const claimed = await executeCrewAction(
      "task.claim",
      { id: "task-1" },
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    expect(claimed.content[0]?.text).toContain("Claimed task-1");

    const done = await executeCrewAction(
      "task.done",
      { id: "task-1", summary: "Added keepalive and tests" },
      state,
      dirs,
      ctx,
      () => {},
      () => {},
      () => {},
    );

    expect(done.content[0]?.text).toContain("Completed task-1");
  });

  it("supports claim/unclaim/complete aliases", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentAlias");
    const ctx = createMockContext(cwd);

    await executeCrewAction("task.create", { title: "Alias task" }, state, dirs, ctx, () => {}, () => {}, () => {});

    const claim = await executeCrewAction("claim", { taskId: "task-1" }, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(claim.content[0]?.text).toContain("Claimed task-1");

    const unclaim = await executeCrewAction("unclaim", { taskId: "task-1" }, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(unclaim.content[0]?.text).toContain("Released claim");

    await executeCrewAction("claim", { taskId: "task-1" }, state, dirs, ctx, () => {}, () => {}, () => {});
    const complete = await executeCrewAction("complete", { taskId: "task-1", summary: "done" }, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(complete.content[0]?.text).toContain("Completed task-1");
  });

  it("returns swarm board summary", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentSwarm");
    const ctx = createMockContext(cwd);

    await executeCrewAction("task.create", { title: "One" }, state, dirs, ctx, () => {}, () => {}, () => {});
    const swarm = await executeCrewAction("swarm", {}, state, dirs, ctx, () => {}, () => {}, () => {});

    expect(swarm.content[0]?.text).toContain("# Agent Swarm");
    expect(swarm.content[0]?.text).toContain("task-1");
  });

  it("archives completed tasks with task.archive_done", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentArchive");
    const ctx = createMockContext(cwd);

    await executeCrewAction("task.create", { title: "Archive me" }, state, dirs, ctx, () => {}, () => {}, () => {});
    await executeCrewAction("task.claim", { id: "task-1" }, state, dirs, ctx, () => {}, () => {}, () => {});
    await executeCrewAction("task.done", { id: "task-1", summary: "done" }, state, dirs, ctx, () => {}, () => {}, () => {});

    const archive = await executeCrewAction("task.archive_done", {}, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(archive.content[0]?.text).toContain("Archived 1 done task");

    const listed = await executeCrewAction("task.list", {}, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(listed.content[0]?.text).toContain("No tasks yet");

    const none = await executeCrewAction("task.archive_done", {}, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(none.content[0]?.text).toContain("No done tasks to archive");
  });

  it("rejects spawn without objective text", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentSpawn");
    const ctx = createMockContext(cwd);

    const res = await executeCrewAction("spawn", { role: "Researcher" }, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(res.content[0]?.text).toContain("spawn requires mission text");
  });

  it("lists no spawned agents initially", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentSpawn");
    const ctx = createMockContext(cwd);

    const res = await executeCrewAction("spawn.list", {}, state, dirs, ctx, () => {}, () => {}, () => {});
    expect(res.content[0]?.text).toContain("No spawned agents");
  });

  it("disables legacy crew orchestration actions", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("AgentLegacy");
    const ctx = createMockContext(cwd);

    const actions = ["plan", "work", "review", "crew.status"];

    for (const action of actions) {
      const res = await executeCrewAction(action, {}, state, dirs, ctx, () => {}, () => {}, vi.fn());
      expect(res.content[0]?.text).toContain("Legacy crew action");
      expect(res.content[0]?.text).toContain("disabled in swarm mode");
    }
  });
});
