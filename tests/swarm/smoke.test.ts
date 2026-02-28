import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MessengerState, Dirs } from "../../lib.js";
import { executeAction } from "../../router.js";
import { createMockContext } from "../helpers/mock-context.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-smoke-"));
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

describe("swarm smoke", () => {
  it("supports peer-created and peer-claimed task flow", async () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const ctx = createMockContext(cwd);

    const alpha = createState("Alpha");
    const beta = createState("Beta");

    const created = await executeAction("task.create", { title: "Smoke task", content: "End-to-end" }, alpha, dirs, ctx, () => {}, () => {}, () => {});
    expect(created.content[0]?.text).toContain("task-1");

    const alphaClaim = await executeAction("task.claim", { id: "task-1" }, alpha, dirs, ctx, () => {}, () => {}, () => {});
    expect(alphaClaim.content[0]?.text).toContain("Claimed task-1");

    const betaClaim = await executeAction("task.claim", { id: "task-1" }, beta, dirs, ctx, () => {}, () => {}, () => {});
    expect(betaClaim.content[0]?.text).toContain("already claimed");

    const done = await executeAction("task.done", { id: "task-1", summary: "completed by alpha" }, alpha, dirs, ctx, () => {}, () => {}, () => {});
    expect(done.content[0]?.text).toContain("Completed task-1");

    const swarm = await executeAction("swarm", {}, alpha, dirs, ctx, () => {}, () => {}, () => {});
    expect(swarm.content[0]?.text).toContain("Summary");
    expect(swarm.content[0]?.text).toContain("1/1 done");
  });
});
