import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatFeedLine, isSwarmEvent, logFeedEvent, pruneFeed, readFeedEvents } from "../feed.js";
import { createTempMessengerDirs } from "./helpers/temp-dirs.js";

describe("feed", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = createTempMessengerDirs().cwd;
  });

  it("writes events to the project-scoped feed path", () => {
    logFeedEvent(cwd, "AgentOne", "join");

    const feedFile = path.join(cwd, ".pi", "messenger", "feed.jsonl");
    expect(fs.existsSync(feedFile)).toBe(true);
    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
  });

  it("reads events back in append order and respects limit", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "src/app.ts");
    logFeedEvent(cwd, "AgentOne", "commit", undefined, "ship feed scope");

    const allEvents = readFeedEvents(cwd, 20);
    expect(allEvents).toHaveLength(3);
    expect(allEvents.map(e => e.type)).toEqual(["join", "edit", "commit"]);

    const limited = readFeedEvents(cwd, 2);
    expect(limited).toHaveLength(2);
    expect(limited.map(e => e.type)).toEqual(["edit", "commit"]);
  });

  it("isolates feeds between project directories", () => {
    const otherCwd = createTempMessengerDirs().cwd;

    logFeedEvent(cwd, "AgentOne", "join");

    expect(readFeedEvents(cwd, 20)).toHaveLength(1);
    expect(readFeedEvents(otherCwd, 20)).toEqual([]);
  });

  it("prunes events within the project-scoped feed", () => {
    logFeedEvent(cwd, "AgentOne", "join");
    logFeedEvent(cwd, "AgentOne", "edit", "a.ts");
    logFeedEvent(cwd, "AgentOne", "edit", "b.ts");
    logFeedEvent(cwd, "AgentOne", "test", undefined, "passed");

    pruneFeed(cwd, 2);

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(2);
    expect(events.map(e => e.type)).toEqual(["edit", "test"]);
    expect(events[0]?.target).toBe("b.ts");
  });

  it("formats planning events with previews and marks them as swarm events", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-11T10:00:00.000Z").toISOString(),
      agent: "Planner",
      type: "plan.pass.start",
      target: "docs/PRD.md",
      preview: "pass 2/3",
    });

    expect(line).toContain("[Swarm]");
    expect(line).toContain("planning pass started");
    expect(line).toContain("pass 2/3");
    expect(isSwarmEvent("plan.pass.start")).toBe(true);
    expect(isSwarmEvent("plan.done")).toBe(true);
    expect(isSwarmEvent("message")).toBe(false);
  });

  it("formats DM message events using target for direction", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      target: "OakBear",
      preview: "Hey, are you exporting the User type?",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("→ OakBear");
    expect(line).toContain("Hey, are you exporting the User type?");
  });

  it("formats broadcast message events with ✦ indicator", () => {
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "EpicGrove",
      type: "message",
      preview: "Starting task-1 — creating src/auth.ts",
    });
    expect(line).toContain("EpicGrove");
    expect(line).toContain("✦");
    expect(line).toContain("Starting task-1");
    expect(line).not.toContain("→");
  });

  it("truncates long message previews in formatFeedLine", () => {
    const longMsg = "A".repeat(150);
    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "Agent",
      type: "message",
      target: "Peer",
      preview: longMsg,
    });
    expect(line).toContain("...");
    expect(line.length).toBeLessThan(200);
  });

  it("normalizes multiline preview text into a single line", () => {
    logFeedEvent(cwd, "AgentOne", "message", "Peer", "Line one\nLine two\tLine three");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    expect(events[0]?.preview).toBe("Line one Line two Line three");

    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "AgentOne",
      type: "commit",
      preview: "feat(scope): add thing\n\nBody details",
    });
    expect(line).toContain("feat(scope): add thing Body details");
    expect(line).not.toContain("\n");
  });

  it("returns an empty array when the feed file does not exist", () => {
    const freshCwd = createTempMessengerDirs().cwd;
    expect(readFeedEvents(freshCwd, 20)).toEqual([]);
  });
});
