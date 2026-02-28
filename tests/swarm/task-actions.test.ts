import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as swarmStore from "../../swarm/store.js";
import { executeTaskAction } from "../../swarm/task-actions.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-actions-"));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

describe("swarm/task-actions", () => {
  it("start claims todo task", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Start me" });

    const res = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(res.success).toBe(true);
    expect(res.task?.status).toBe("in_progress");
    expect(res.task?.claimed_by).toBe("AgentA");
  });

  it("start blocks on unmet dependencies", () => {
    const cwd = createTempCwd();
    const dep = swarmStore.createTask(cwd, { title: "Dependency" });
    const task = swarmStore.createTask(cwd, { title: "Main", dependsOn: [dep.id] });

    const res = executeTaskAction(cwd, "start", task.id, "AgentA");

    expect(res.success).toBe(false);
    expect(res.error).toBe("unmet_dependencies");
    expect(res.unmetDependencies).toEqual([dep.id]);
  });

  it("block and unblock transitions state", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Block flow" });

    executeTaskAction(cwd, "start", task.id, "AgentA");
    const blocked = executeTaskAction(cwd, "block", task.id, "AgentA", "need schema");
    expect(blocked.success).toBe(true);
    expect(blocked.task?.status).toBe("blocked");

    const unblocked = executeTaskAction(cwd, "unblock", task.id, "AgentA");
    expect(unblocked.success).toBe(true);
    expect(unblocked.task?.status).toBe("todo");
  });

  it("stop unclaims in-progress task", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Stop flow" });

    executeTaskAction(cwd, "start", task.id, "AgentA");
    const stopped = executeTaskAction(cwd, "stop", task.id, "AgentA");

    expect(stopped.success).toBe(true);
    expect(stopped.task?.status).toBe("todo");
    expect(stopped.task?.claimed_by).toBeUndefined();
  });

  it("delete respects active worker guard", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Delete guard" });

    executeTaskAction(cwd, "start", task.id, "AgentA");

    const blocked = executeTaskAction(cwd, "delete", task.id, "AgentA", undefined, {
      isWorkerActive: () => true,
    });

    expect(blocked.success).toBe(false);
    expect(blocked.error).toBe("active_worker");

    const deleted = executeTaskAction(cwd, "delete", task.id, "AgentA", undefined, {
      isWorkerActive: () => false,
    });

    expect(deleted.success).toBe(true);
    expect(swarmStore.getTask(cwd, task.id)).toBeNull();
  });

  it("archives only done tasks", () => {
    const cwd = createTempCwd();
    const done = swarmStore.createTask(cwd, { title: "Done task" });
    const todo = swarmStore.createTask(cwd, { title: "Todo task" });

    executeTaskAction(cwd, "start", done.id, "AgentA");
    swarmStore.completeTask(cwd, done.id, "AgentA", "done");

    const invalid = executeTaskAction(cwd, "archive", todo.id, "AgentA");
    expect(invalid.success).toBe(false);
    expect(invalid.error).toBe("invalid_status");
    expect(swarmStore.getTask(cwd, todo.id)).not.toBeNull();

    const archived = executeTaskAction(cwd, "archive", done.id, "AgentA");
    expect(archived.success).toBe(true);
    expect(swarmStore.getTask(cwd, done.id)).toBeNull();
  });

  it("reset and cascade-reset revert task tree", () => {
    const cwd = createTempCwd();
    const parent = swarmStore.createTask(cwd, { title: "Parent" });
    const child = swarmStore.createTask(cwd, { title: "Child", dependsOn: [parent.id] });

    executeTaskAction(cwd, "start", parent.id, "AgentA");
    swarmStore.completeTask(cwd, parent.id, "AgentA", "done");

    executeTaskAction(cwd, "start", child.id, "AgentB");
    swarmStore.completeTask(cwd, child.id, "AgentB", "done");

    const single = executeTaskAction(cwd, "reset", parent.id, "AgentA");
    expect(single.success).toBe(true);
    expect(swarmStore.getTask(cwd, parent.id)?.status).toBe("todo");
    expect(swarmStore.getTask(cwd, child.id)?.status).toBe("done");

    const cascade = executeTaskAction(cwd, "cascade-reset", parent.id, "AgentA");
    expect(cascade.success).toBe(true);
    expect(swarmStore.getTask(cwd, child.id)?.status).toBe("todo");
  });
});
