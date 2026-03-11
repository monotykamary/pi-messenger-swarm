import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { Dirs, MessengerState } from "../lib.js";
import * as store from "../store.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-channel-"));
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
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: "test-model",
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    currentChannel: "",
    sessionChannel: "",
    joinedChannels: [],
  };
}

function createContext(cwd: string, sessionId: string): ExtensionContext {
  return {
    hasUI: false,
    cwd,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: () => {},
      setStatus: () => {},
      custom: async () => undefined,
    } as ExtensionContext["ui"],
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => sessionId,
    } as ExtensionContext["sessionManager"],
    model: { id: "test-model" },
  } as unknown as ExtensionContext;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
  delete process.env.PI_MESSENGER_CHANNEL;
});

describe("channel-aware registration", () => {
  it("tolerates malformed legacy channel files without ids", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const channelsDir = path.join(dirs.base, "channels");
    fs.mkdirSync(channelsDir, { recursive: true });
    fs.writeFileSync(path.join(channelsDir, "memory.json"), JSON.stringify({ description: "legacy file missing id" }, null, 2));

    const listed = store.joinChannel(createState("Probe"), dirs, "memory", { create: false });
    expect(listed.success).toBe(true);
  });

  it("creates phrase-based session channels and restores them for the same pi session id", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const ctx = createContext(cwd, "session-abc");

    const first = createState("Alpha");
    expect(store.register(first, dirs, ctx)).toBe(true);
    const initialChannel = first.currentChannel;
    expect(initialChannel).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)+$/);
    expect(initialChannel).not.toBe("memory");
    expect(initialChannel).not.toBe("heartbeat");
    expect(first.joinedChannels).toContain(initialChannel);
    expect(first.joinedChannels).toContain("memory");
    expect(first.joinedChannels).toContain("heartbeat");
    store.unregister(first, dirs);

    const second = createState("Alpha");
    expect(store.register(second, dirs, ctx)).toBe(true);
    expect(second.currentChannel).toBe(initialChannel);
    expect(second.sessionChannel).toBe(initialChannel);
  });

  it("avoids collisions when two session channels would get the same phrase", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const ctxA = createContext(cwd, "session-a");
    const ctxB = createContext(cwd, "session-b");

    const originalRandom = Math.random;
    Math.random = () => 0.123456789;
    try {
      const first = createState("Alpha");
      expect(store.register(first, dirs, ctxA)).toBe(true);
      const second = createState("Beta");
      expect(store.register(second, dirs, ctxB)).toBe(true);
      expect(second.currentChannel).not.toBe(first.currentChannel);
      expect(second.currentChannel.startsWith(first.currentChannel)).toBe(true);
    } finally {
      Math.random = originalRandom;
    }
  });

  it("rebinds stale cached state back to the resumed pi session channel", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const oldCtx = createContext(cwd, "session-old");
    const newCtx = createContext(cwd, "session-new");

    const state = createState("Alpha");
    expect(store.register(state, dirs, oldCtx)).toBe(true);
    const oldChannel = state.currentChannel;
    store.unregister(state, dirs);

    expect(store.register(state, dirs, newCtx)).toBe(true);
    const newChannel = state.currentChannel;
    expect(newChannel).not.toBe(oldChannel);
    expect(store.joinChannel(state, dirs, "architecture", { create: true }).success).toBe(true);
    store.unregister(state, dirs);

    expect(store.register(state, dirs, oldCtx)).toBe(true);
    expect(state.currentChannel).toBe(oldChannel);
    expect(state.sessionChannel).toBe(oldChannel);
    expect(state.joinedChannels).toContain("architecture");
    expect(state.joinedChannels).not.toContain(newChannel);
  });

  it("rebinds a live messenger instance when pi switches sessions", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const oldCtx = createContext(cwd, "session-old");
    const newCtx = createContext(cwd, "session-new");

    const seed = createState("Seed");
    expect(store.register(seed, dirs, oldCtx)).toBe(true);
    const oldChannel = seed.currentChannel;
    store.unregister(seed, dirs);

    const state = createState("Alpha");
    expect(store.register(state, dirs, newCtx)).toBe(true);
    const newChannel = state.currentChannel;
    expect(store.joinChannel(state, dirs, "architecture", { create: true }).success).toBe(true);

    const rebound = store.rebindContextSession(state, dirs, oldCtx);
    expect(rebound.changed).toBe(true);
    expect(state.currentChannel).toBe(oldChannel);
    expect(state.sessionChannel).toBe(oldChannel);
    expect(state.joinedChannels).toContain("architecture");
    expect(state.joinedChannels).not.toContain(newChannel);
    expect(store.getAgentRegistration(dirs, "Alpha")?.sessionId).toBe("session-old");
  });

  it("inherits an explicit channel for spawned or nested sessions", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const ctx = createContext(cwd, "child-session");

    process.env.PI_MESSENGER_CHANNEL = "memory";
    const state = createState("Worker");
    expect(store.register(state, dirs, ctx)).toBe(true);
    expect(state.currentChannel).toBe("memory");
    expect(state.sessionChannel).toBe("memory");
  });

  it("can explicitly join and create named channels", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const ctx = createContext(cwd, "session-join");

    const state = createState("Alpha");
    expect(store.register(state, dirs, ctx)).toBe(true);

    const joined = store.joinChannel(state, dirs, "architecture", { create: true });
    expect(joined.success).toBe(true);
    expect(state.currentChannel).toBe("architecture");
    expect(state.joinedChannels).toContain("architecture");
    expect(fs.existsSync(path.join(dirs.base, "channels", "architecture.json"))).toBe(true);
  });
});
