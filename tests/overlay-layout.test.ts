import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dirs, MessengerState } from "../lib.js";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (text: string, width: number) => text.length > width ? text.slice(0, Math.max(0, width)) : text,
  visibleWidth: (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").length,
  matchesKey: () => false,
}));

const roots = new Set<string>();
const theme = {
  fg: (_name: string, text: string) => text,
};

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-overlay-layout-"));
  roots.add(cwd);
  fs.mkdirSync(path.join(cwd, ".pi", "messenger", "registry"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".pi", "messenger", "inbox"), { recursive: true });
  return cwd;
}

function makeDirs(cwd: string): Dirs {
  return {
    base: path.join(cwd, ".pi", "messenger"),
    registry: path.join(cwd, ".pi", "messenger", "registry"),
    inbox: path.join(cwd, ".pi", "messenger", "inbox"),
  };
}

function makeState(): MessengerState {
  const now = new Date().toISOString();
  return {
    agentName: "BenchAgent",
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map([["general", 0]]),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: "bench",
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: now },
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: now,
    currentChannel: "general",
    sessionChannel: "general",
    joinedChannels: ["general"],
  };
}

function setTerminalSize(rows: number, columns: number): () => void {
  const rowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
  const columnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "rows", { configurable: true, value: rows });
  Object.defineProperty(process.stdout, "columns", { configurable: true, value: columns });
  return () => {
    if (rowsDescriptor) Object.defineProperty(process.stdout, "rows", rowsDescriptor);
    if (columnsDescriptor) Object.defineProperty(process.stdout, "columns", columnsDescriptor);
  };
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

describe("overlay layout", () => {
  it("expands the feed viewport when the task panel uses fewer lines than budgeted", async () => {
    const cwd = createTempCwd();
    const dirs = makeDirs(cwd);
    const state = makeState();
    const restoreTerminal = setTerminalSize(16, 100);
    const previousCwd = process.cwd();
    process.chdir(cwd);

    try {
      const swarmStore = await import("../swarm/store.js");
      const { logFeedEvent } = await import("../feed.js");
      const { MessengerOverlay } = await import("../overlay.js");

      swarmStore.createTask(cwd, {
        title: "Single visible task",
        createdBy: "BenchAgent",
      });

      for (let i = 0; i < 10; i++) {
        logFeedEvent(cwd, "BenchAgent", "message", undefined, `Msg ${i}`);
      }

      const overlay = new MessengerOverlay(
        { requestRender: () => {} } as any,
        theme as any,
        state,
        dirs,
        () => {},
        {},
      );

      const frame = overlay.render(100);
      overlay.dispose();

      const visibleMessages = frame.filter(line => line.includes("Msg "));
      expect(visibleMessages).toHaveLength(6);
      expect(visibleMessages.at(-1)).toContain("Msg 9");
    } finally {
      process.chdir(previousCwd);
      restoreTerminal();
    }
  });
});
