import { beforeEach, describe, expect, it } from "vitest";
import {
  addWaveResult,
  autonomousState,
  restoreAutonomousState,
  startAutonomous,
  stopAutonomous,
} from "../../crew/state.js";

function resetAutonomousState(): void {
  autonomousState.active = false;
  autonomousState.cwd = null;
  autonomousState.waveNumber = 0;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = null;
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
}

describe("crew/state", () => {
  beforeEach(() => {
    resetAutonomousState();
  });

  it("startAutonomous initializes state and marks active", () => {
    startAutonomous("/tmp/project-a");

    expect(autonomousState.active).toBe(true);
    expect(autonomousState.cwd).toBe("/tmp/project-a");
    expect(autonomousState.waveNumber).toBe(1);
    expect(autonomousState.waveHistory).toEqual([]);
    expect(autonomousState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autonomousState.stoppedAt).toBeNull();
    expect(autonomousState.stopReason).toBeNull();
  });

  it("stopAutonomous marks inactive and records reason/timestamp", () => {
    startAutonomous("/tmp/project-a");
    stopAutonomous("manual");

    expect(autonomousState.active).toBe(false);
    expect(autonomousState.stopReason).toBe("manual");
    expect(autonomousState.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("addWaveResult appends history and increments waveNumber", () => {
    startAutonomous("/tmp/project-a");

    addWaveResult({
      waveNumber: 1,
      tasksAttempted: ["task-1"],
      succeeded: ["task-1"],
      failed: [],
      blocked: [],
      timestamp: new Date().toISOString(),
    });

    expect(autonomousState.waveHistory).toHaveLength(1);
    expect(autonomousState.waveHistory[0].waveNumber).toBe(1);
    expect(autonomousState.waveNumber).toBe(2);
  });

  it("restoreAutonomousState applies partial persisted fields", () => {
    restoreAutonomousState({
      active: true,
      cwd: "/tmp/project-b",
      waveNumber: 7,
      stopReason: "blocked",
    });

    expect(autonomousState.active).toBe(true);
    expect(autonomousState.cwd).toBe("/tmp/project-b");
    expect(autonomousState.waveNumber).toBe(7);
    expect(autonomousState.stopReason).toBe("blocked");
  });

  it("supports full transition sequence start -> waves -> stop -> restore", () => {
    startAutonomous("/tmp/project-c");
    addWaveResult({
      waveNumber: 1,
      tasksAttempted: ["task-1", "task-2"],
      succeeded: ["task-1"],
      failed: ["task-2"],
      blocked: [],
      timestamp: new Date().toISOString(),
    });
    addWaveResult({
      waveNumber: 2,
      tasksAttempted: ["task-2"],
      succeeded: ["task-2"],
      failed: [],
      blocked: [],
      timestamp: new Date().toISOString(),
    });
    stopAutonomous("completed");

    const snapshot = {
      active: autonomousState.active,
      cwd: autonomousState.cwd,
      waveNumber: autonomousState.waveNumber,
      waveHistory: [...autonomousState.waveHistory],
      startedAt: autonomousState.startedAt,
      stoppedAt: autonomousState.stoppedAt,
      stopReason: autonomousState.stopReason,
    };

    resetAutonomousState();
    restoreAutonomousState(snapshot);

    expect(autonomousState.active).toBe(false);
    expect(autonomousState.cwd).toBe("/tmp/project-c");
    expect(autonomousState.waveNumber).toBe(3);
    expect(autonomousState.waveHistory).toHaveLength(2);
    expect(autonomousState.stopReason).toBe("completed");
    expect(autonomousState.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(autonomousState.stoppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
