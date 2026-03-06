import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../swarm/progress.js", () => ({
  createProgress: () => ({
    tokens: 0,
    toolCallCount: 0,
    recentTools: [],
    status: "running",
  }),
  parseJsonlLine: () => null,
  updateProgress: () => {},
}));

vi.mock("../../swarm/live-progress.js", () => ({
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

describe("swarm spawn model fallback", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("falls back to default model when specified model is not found", () => {
    const cwd = createTempCwd();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First spawn fails with model not found
    const failingProc = new FakeProcess();
    // Second spawn succeeds
    const successProc = new FakeProcess();

    spawnMock
      .mockReturnValueOnce(failingProc as any)
      .mockReturnValueOnce(successProc as any);

    const spawned = spawnSubagent(cwd, {
      role: "Test Role",
      objective: "Test objective",
      model: "invalid/model-name",
      name: "TestBot",
    });

    // Initially only spawned once
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // First call should have the invalid model
    const firstCallArgs = spawnMock.mock.calls[0][1] as string[];
    expect(firstCallArgs).toContain("--model");
    expect(firstCallArgs).toContain("model-name");
    expect(firstCallArgs).toContain("--provider");
    expect(firstCallArgs).toContain("invalid");

    // Emit error on first process to trigger fallback
    failingProc.stderr.emit("data", 'Model "invalid/model-name" not found. Use --list-models to see available models.');
    failingProc.emit("close", 1);

    // Now should have tried to spawn twice
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Second call should NOT have model args
    const secondCallArgs = spawnMock.mock.calls[1][1] as string[];
    expect(secondCallArgs).not.toContain("--model");
    expect(secondCallArgs).not.toContain("invalid");

    // Should warn about fallback
    expect(consoleSpy).toHaveBeenCalledWith(
      '[spawn] Model "invalid/model-name" not found, using default model'
    );

    // Verify record was updated to remove model
    expect(spawned.model).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("does not fallback when model exists", () => {
    const cwd = createTempCwd();
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const spawned = spawnSubagent(cwd, {
      role: "Test Role",
      objective: "Test objective",
      model: "anthropic/claude-haiku-4-5",
      name: "TestBot",
    });

    // Should only spawn once
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Should have the model
    expect(spawned.model).toBe("anthropic/claude-haiku-4-5");

    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain("--model");
    expect(args).toContain("claude-haiku-4-5");
  });

  it("only tries fallback once", () => {
    const cwd = createTempCwd();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const firstFail = new FakeProcess();
    const secondFail = new FakeProcess();

    spawnMock
      .mockReturnValueOnce(firstFail as any)
      .mockReturnValueOnce(secondFail as any);

    const spawned = spawnSubagent(cwd, {
      role: "Test Role",
      objective: "Test objective",
      model: "invalid/model",
      name: "TestBot",
    });

    // Initially model is set
    expect(spawned.model).toBe("invalid/model");

    // First process fails with model not found
    firstFail.stderr.emit("data", 'Model "invalid/model" not found.');
    firstFail.emit("close", 1);

    // Should have spawned twice (original + 1 fallback)
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // Record should have been updated to remove model
    expect(spawned.model).toBeUndefined();

    // Second process also fails (but for a different reason)
    secondFail.stderr.emit("data", "Some other error");
    secondFail.emit("close", 1);

    // Should STILL only have spawned twice (no more fallbacks)
    expect(spawnMock).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });
});
