import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../crew/utils/progress.js", () => ({
  createProgress: () => ({
    tokens: 0,
    toolCallCount: 0,
    recentTools: [],
    status: "running",
  }),
  parseJsonlLine: () => null,
  updateProgress: () => {},
}));

vi.mock("../../crew/live-progress.js", () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import { spawnSubagent, clearSpawnStateForTests } from "../../swarm/spawn.js";

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-spawn-"));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
});

describe("swarm spawn system prompt", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("adds role/persona/objective to appended system prompt", () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, {
      role: "Packaging Gap Analyst",
      persona: "Skeptical market researcher",
      objective: "Analyze ideabrowser.com and identify product packaging opportunities",
      context: "Focus on monetization friction and onboarding",
      name: "RoleBot",
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    const idx = args.indexOf("--append-system-prompt");
    expect(idx).toBeGreaterThan(-1);

    const promptPath = args[idx + 1];
    const content = fs.readFileSync(promptPath, "utf-8");

    expect(content).toContain("## Role Description");
    expect(content).toContain("Packaging Gap Analyst");
    expect(content).toContain("Skeptical market researcher");
    expect(content).toContain("Analyze ideabrowser.com and identify product packaging opportunities");

    proc.emit("close", 0);
    expect(fs.existsSync(path.dirname(promptPath))).toBe(false);
  });
});
