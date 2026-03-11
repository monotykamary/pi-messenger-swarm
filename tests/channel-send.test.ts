import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRegistration, Dirs, MessengerState } from "../lib.js";
import { executeSend } from "../handlers.js";

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-channel-send-"));
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
    currentChannel: "wild-viper",
    sessionChannel: "wild-viper",
    joinedChannels: ["wild-viper", "memory", "heartbeat"],
  };
}

function writeRegistration(dirs: Dirs, registration: AgentRegistration): void {
  fs.writeFileSync(path.join(dirs.registry, `${registration.name}.json`), JSON.stringify(registration, null, 2));
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

describe("channel-targeted send", () => {
  it("treats to: '#memory' as a durable channel post plus live delivery", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("DarkMoon");

    writeRegistration(dirs, {
      name: "MintZenith",
      pid: process.pid,
      sessionId: "peer-session",
      cwd,
      model: "test-model",
      startedAt: new Date().toISOString(),
      isHuman: false,
      session: { toolCalls: 0, tokens: 0, filesModified: [] },
      activity: { lastActivityAt: new Date().toISOString() },
      currentChannel: "quiet-ember",
      sessionChannel: "quiet-ember",
      joinedChannels: ["quiet-ember", "memory", "heartbeat"],
    });

    const res = executeSend(state, dirs, cwd, "#memory", "remember this");
    expect(res.content[0]?.text).toContain("Message posted to #memory and delivered to 1 peer");

    const inboxDir = path.join(dirs.inbox, "MintZenith", "memory");
    expect(fs.existsSync(inboxDir)).toBe(true);
    expect(fs.readdirSync(inboxDir)).toHaveLength(1);

    const feedPath = path.join(dirs.base, "feed", "memory.jsonl");
    expect(fs.existsSync(feedPath)).toBe(true);
    expect(fs.readFileSync(feedPath, "utf8")).toContain("remember this");
  });

  it("allows posting to '#memory' even when no agents are currently joined", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("DarkMoon");

    const res = executeSend(state, dirs, cwd, "#memory", "store this for later");
    expect(res.content[0]?.text).toContain("Message posted to #memory.");

    const feedPath = path.join(dirs.base, "feed", "memory.jsonl");
    expect(fs.existsSync(feedPath)).toBe(true);
    expect(fs.readFileSync(feedPath, "utf8")).toContain("store this for later");
  });

  it("allows posting into the current session channel when explicitly targeted", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("DarkMoon");

    const res = executeSend(state, dirs, cwd, "#wild-viper", "pick this up later");
    expect(res.content[0]?.text).toContain("Message posted to #wild-viper.");

    const feedPath = path.join(dirs.base, "feed", "wild-viper.jsonl");
    expect(fs.existsSync(feedPath)).toBe(true);
    expect(fs.readFileSync(feedPath, "utf8")).toContain("pick this up later");
  });

  it("requires an explicit to target", () => {
    const cwd = createTempCwd();
    const dirs = createDirs(cwd);
    const state = createState("DarkMoon");

    const res = executeSend(state, dirs, cwd, undefined, "pick this up later");
    expect(res.content[0]?.text).toContain("send requires 'to'");
  });
});
