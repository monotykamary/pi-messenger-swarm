import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as swarmStore from "../../swarm/store.js";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
}));

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-swarm-statusbar-"));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  roots.clear();
});

const theme = {
  fg: (_name: string, text: string) => text,
};

describe("swarm status bar litmus", () => {
  let renderStatusBar: typeof import("../../overlay-render.js").renderStatusBar;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../overlay-render.js");
    renderStatusBar = mod.renderStatusBar;
  });

  it("shows empty-state status when no tasks exist", () => {
    const cwd = createTempCwd();
    const line = renderStatusBar(theme as any, cwd, 120);
    expect(line).toContain("No swarm tasks");
  });

  it("shows summary counts when tasks exist", () => {
    const cwd = createTempCwd();

    const t1 = swarmStore.createTask(cwd, { title: "Done" });
    const t2 = swarmStore.createTask(cwd, { title: "In progress" });

    swarmStore.claimTask(cwd, t1.id, "AgentA");
    swarmStore.completeTask(cwd, t1.id, "AgentA", "done");
    swarmStore.claimTask(cwd, t2.id, "AgentB");

    const line = renderStatusBar(theme as any, cwd, 120);
    expect(line).toContain("Swarm 1/2");
    expect(line).toContain("ready 0");
    expect(line).toContain("in progress 1");
  });
});
