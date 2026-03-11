import { describe, expect, it } from "vitest";
import { createTempMessengerDirs } from "../helpers/temp-dirs.js";
import * as swarmStore from "../../swarm/store.js";
import { logFeedEvent, readFeedEvents } from "../../feed.js";

describe("swarm channel isolation", () => {
  it("keeps task boards isolated per channel, even with the same task ids", () => {
    const dirs = createTempMessengerDirs();

    const sessionTask = swarmStore.createTask(dirs.cwd, { title: "Session task" }, "session-a");
    const memoryTask = swarmStore.createTask(dirs.cwd, { title: "Memory task" }, "memory");

    expect(sessionTask.id).toBe("task-1");
    expect(memoryTask.id).toBe("task-1");

    expect(swarmStore.getTasks(dirs.cwd, "session-a").map(task => task.title)).toEqual(["Session task"]);
    expect(swarmStore.getTasks(dirs.cwd, "memory").map(task => task.title)).toEqual(["Memory task"]);
  });

  it("archives completed tasks inside the originating channel archive tree", () => {
    const dirs = createTempMessengerDirs();

    const task = swarmStore.createTask(dirs.cwd, { title: "Archive me" }, "memory");
    swarmStore.claimTask(dirs.cwd, task.id, "AgentA", undefined, "memory");
    swarmStore.completeTask(dirs.cwd, task.id, "AgentA", "done", undefined, "memory");

    const archived = swarmStore.archiveDoneTasks(dirs.cwd, "memory");
    expect(archived.archived).toBe(1);
    expect(archived.archiveDir).toContain("/archive/memory/");
    expect(swarmStore.getTasks(dirs.cwd, "memory")).toEqual([]);
  });

  it("keeps feed history isolated per channel", () => {
    const dirs = createTempMessengerDirs();

    logFeedEvent(dirs.cwd, "AgentA", "message", undefined, "session hello", "session-a");
    logFeedEvent(dirs.cwd, "AgentA", "message", undefined, "memory hello", "memory");

    expect(readFeedEvents(dirs.cwd, 20, "session-a").map(event => event.preview)).toEqual(["session hello"]);
    expect(readFeedEvents(dirs.cwd, 20, "memory").map(event => event.preview)).toEqual(["memory hello"]);
  });
});
