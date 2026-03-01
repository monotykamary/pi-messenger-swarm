import * as fs from "node:fs";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { formatFeedLine, isSwarmEvent, logFeedEvent, pruneFeed, readFeedEvents, readFeedEventsWithOffset, readFeedEventsByRange, getFeedLineCount } from "../feed.js";
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

  it("preserves newlines in preview text for multi-line display", () => {
    logFeedEvent(cwd, "AgentOne", "message", "Peer", "Line one\nLine two\tLine three");

    const events = readFeedEvents(cwd, 20);
    expect(events).toHaveLength(1);
    // Newlines are preserved, tabs normalized to spaces
    expect(events[0]?.preview).toBe("Line one\nLine two Line three");

    const line = formatFeedLine({
      ts: new Date("2026-02-13T10:00:00.000Z").toISOString(),
      agent: "AgentOne",
      type: "commit",
      preview: "feat(scope): add thing\n\nBody details",
    });
    // formatFeedLine still normalizes to single line for display
    // Note: \n\n becomes two spaces, so we check for the content without exact spacing
    expect(line).toContain("feat(scope): add thing");
    expect(line).toContain("Body details");
    expect(line).not.toContain("\n");
  });

  it("returns an empty array when the feed file does not exist", () => {
    const freshCwd = createTempMessengerDirs().cwd;
    expect(readFeedEvents(freshCwd, 20)).toEqual([]);
  });

  describe("progressive loading", () => {
    it("reads events by offset from end", () => {
      // Create 10 events
      for (let i = 0; i < 10; i++) {
        logFeedEvent(cwd, `Agent${i}`, "message", undefined, `Message ${i}`);
      }

      // Read last 3 events (offset 0, limit 3)
      const last3 = readFeedEventsWithOffset(cwd, 0, 3);
      expect(last3).toHaveLength(3);
      expect(last3[0]?.preview).toBe("Message 7");
      expect(last3[2]?.preview).toBe("Message 9");

      // Read 3 events starting from offset 3 (skip last 3, get next 3)
      const middle3 = readFeedEventsWithOffset(cwd, 3, 3);
      expect(middle3).toHaveLength(3);
      expect(middle3[0]?.preview).toBe("Message 4");
      expect(middle3[2]?.preview).toBe("Message 6");
    });

    it("reads events by absolute index range", () => {
      for (let i = 0; i < 10; i++) {
        logFeedEvent(cwd, `Agent${i}`, "message", undefined, `Message ${i}`);
      }

      // Read events 2-5 (indices 2, 3, 4)
      const range = readFeedEventsByRange(cwd, 2, 5);
      expect(range).toHaveLength(3);
      expect(range[0]?.preview).toBe("Message 2");
      expect(range[2]?.preview).toBe("Message 4");
    });

    it("clamps range indices to valid bounds", () => {
      for (let i = 0; i < 5; i++) {
        logFeedEvent(cwd, `Agent${i}`, "message", undefined, `Message ${i}`);
      }

      // Range beyond file should clamp
      const beyond = readFeedEventsByRange(cwd, 100, 200);
      expect(beyond).toEqual([]);

      // Partial overlap should return valid portion
      const partial = readFeedEventsByRange(cwd, 3, 100);
      expect(partial).toHaveLength(2); // events 3 and 4
      expect(partial[0]?.preview).toBe("Message 3");
    });

    it("returns correct total line count", () => {
      expect(getFeedLineCount(cwd)).toBe(0);

      logFeedEvent(cwd, "Agent1", "join");
      expect(getFeedLineCount(cwd)).toBe(1);

      logFeedEvent(cwd, "Agent2", "leave");
      logFeedEvent(cwd, "Agent3", "message", undefined, "hi");
      expect(getFeedLineCount(cwd)).toBe(3);
    });

    it("returns empty array for invalid offset/range", () => {
      logFeedEvent(cwd, "Agent", "join");

      // Offset beyond file
      expect(readFeedEventsWithOffset(cwd, 100, 10)).toEqual([]);

      // Empty range
      expect(readFeedEventsByRange(cwd, 5, 5)).toEqual([]);
    });
  });
});
