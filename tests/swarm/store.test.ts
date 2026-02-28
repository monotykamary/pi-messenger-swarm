import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as swarmStore from "../../swarm/store.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-store-"));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

describe("swarm/store", () => {
  it("creates tasks with markdown spec files", () => {
    const cwd = createTempCwd();

    const task = swarmStore.createTask(cwd, {
      title: "Investigate auth regression",
      content: "Check middleware ordering",
      createdBy: "AgentOne",
    });

    expect(task.id).toBe("task-1");
    expect(task.status).toBe("todo");

    const spec = swarmStore.getTaskSpec(cwd, task.id);
    expect(spec).toContain("Investigate auth regression");
    expect(spec).toContain("Check middleware ordering");
  });

  it("allocates incremental task IDs", () => {
    const cwd = createTempCwd();

    const t1 = swarmStore.createTask(cwd, { title: "T1" });
    const t2 = swarmStore.createTask(cwd, { title: "T2" });
    const t3 = swarmStore.createTask(cwd, { title: "T3" });

    expect([t1.id, t2.id, t3.id]).toEqual(["task-1", "task-2", "task-3"]);
  });

  it("computes ready tasks from dependency completion", () => {
    const cwd = createTempCwd();

    const base = swarmStore.createTask(cwd, { title: "Base" });
    const dependent = swarmStore.createTask(cwd, { title: "Dependent", dependsOn: [base.id] });

    expect(swarmStore.getReadyTasks(cwd).map(t => t.id)).toEqual([base.id]);

    const claimed = swarmStore.claimTask(cwd, base.id, "AgentA");
    expect(claimed?.status).toBe("in_progress");

    const done = swarmStore.completeTask(cwd, base.id, "AgentA", "done");
    expect(done?.status).toBe("done");

    expect(swarmStore.getReadyTasks(cwd).map(t => t.id)).toEqual([dependent.id]);
  });

  it("enforces claim ownership for unclaim and complete", () => {
    const cwd = createTempCwd();

    const task = swarmStore.createTask(cwd, { title: "Claim test" });
    expect(swarmStore.claimTask(cwd, task.id, "AgentA")).not.toBeNull();

    expect(swarmStore.unclaimTask(cwd, task.id, "AgentB")).toBeNull();
    expect(swarmStore.completeTask(cwd, task.id, "AgentB", "oops")).toBeNull();

    expect(swarmStore.completeTask(cwd, task.id, "AgentA", "done")).not.toBeNull();
  });

  it("writes and reads progress logs", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Progress test" });

    swarmStore.appendTaskProgress(cwd, task.id, "AgentA", "Started triage");
    swarmStore.appendTaskProgress(cwd, task.id, "AgentA", "Found failing test");

    const progress = swarmStore.getTaskProgress(cwd, task.id);
    expect(progress).toContain("Started triage");
    expect(progress).toContain("Found failing test");
  });

  it("supports block and unblock workflow", () => {
    const cwd = createTempCwd();
    const task = swarmStore.createTask(cwd, { title: "Block me" });

    swarmStore.claimTask(cwd, task.id, "AgentA");
    const blocked = swarmStore.blockTask(cwd, task.id, "AgentA", "Waiting on API key");

    expect(blocked?.status).toBe("blocked");
    expect(blocked?.blocked_reason).toBe("Waiting on API key");
    expect(swarmStore.getBlockContext(cwd, task.id)).toContain("Waiting on API key");

    const unblocked = swarmStore.unblockTask(cwd, task.id);
    expect(unblocked?.status).toBe("todo");
    expect(unblocked?.blocked_reason).toBeUndefined();
  });

  it("resets dependents in cascade mode", () => {
    const cwd = createTempCwd();

    const t1 = swarmStore.createTask(cwd, { title: "T1" });
    const t2 = swarmStore.createTask(cwd, { title: "T2", dependsOn: [t1.id] });

    swarmStore.claimTask(cwd, t1.id, "AgentA");
    swarmStore.completeTask(cwd, t1.id, "AgentA", "done");

    swarmStore.claimTask(cwd, t2.id, "AgentB");
    swarmStore.completeTask(cwd, t2.id, "AgentB", "done");

    const reset = swarmStore.resetTask(cwd, t1.id, true);
    const ids = reset.map(task => task.id);

    expect(ids).toContain(t1.id);
    expect(ids).toContain(t2.id);
    expect(swarmStore.getTask(cwd, t2.id)?.status).toBe("todo");
  });

  it("deletes tasks and detaches downstream dependencies", () => {
    const cwd = createTempCwd();

    const parent = swarmStore.createTask(cwd, { title: "Parent" });
    const child = swarmStore.createTask(cwd, { title: "Child", dependsOn: [parent.id] });

    expect(swarmStore.deleteTask(cwd, parent.id)).toBe(true);
    expect(swarmStore.getTask(cwd, parent.id)).toBeNull();
    expect(swarmStore.getTask(cwd, child.id)?.depends_on).toEqual([]);
  });

  it("archives done tasks and rewires remaining dependencies", () => {
    const cwd = createTempCwd();

    const doneBase = swarmStore.createTask(cwd, { title: "Done base" });
    const followup = swarmStore.createTask(cwd, { title: "Followup", dependsOn: [doneBase.id] });

    swarmStore.claimTask(cwd, doneBase.id, "AgentA");
    swarmStore.completeTask(cwd, doneBase.id, "AgentA", "done");

    const archived = swarmStore.archiveDoneTasks(cwd);

    expect(archived.archived).toBe(1);
    expect(archived.archivedIds).toEqual([doneBase.id]);
    expect(archived.archiveDir).toBeTruthy();
    expect(swarmStore.getTask(cwd, doneBase.id)).toBeNull();

    const archiveJson = path.join(archived.archiveDir!, "tasks", `${doneBase.id}.json`);
    expect(fs.existsSync(archiveJson)).toBe(true);

    expect(swarmStore.getTask(cwd, followup.id)?.depends_on).toEqual([]);
    expect(swarmStore.getReadyTasks(cwd).map(task => task.id)).toContain(followup.id);
  });

  it("summarizes swarm status counts", () => {
    const cwd = createTempCwd();

    const t1 = swarmStore.createTask(cwd, { title: "todo" });
    const t2 = swarmStore.createTask(cwd, { title: "active" });
    const t3 = swarmStore.createTask(cwd, { title: "done" });
    const t4 = swarmStore.createTask(cwd, { title: "blocked" });

    swarmStore.claimTask(cwd, t2.id, "AgentA");
    swarmStore.claimTask(cwd, t3.id, "AgentB");
    swarmStore.completeTask(cwd, t3.id, "AgentB", "done");
    swarmStore.blockTask(cwd, t4.id, "AgentC", "blocked");

    const summary = swarmStore.getSummary(cwd);
    expect(summary.total).toBe(4);
    expect(summary.todo).toBe(1);
    expect(summary.in_progress).toBe(1);
    expect(summary.done).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(swarmStore.agentHasClaimedTask(cwd, "AgentA")).toBe(true);
    expect(swarmStore.agentHasClaimedTask(cwd, "AgentZ")).toBe(false);
    expect(swarmStore.hasAnyTasks(cwd)).toBe(true);
    expect(t1.id).toBe("task-1");
  });
});
