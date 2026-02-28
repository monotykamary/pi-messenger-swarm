import { describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  truncateToWidth: (s: string) => s,
}));

import { createMessengerViewState } from "../../overlay-actions.js";
import { renderLegend, renderSwarmList } from "../../overlay-render.js";
import type { SpawnedAgent } from "../../swarm/types.js";

const theme = {
  fg: (_name: string, text: string) => text,
};

describe("overlay swarm list view", () => {
  it("renders spawned agent name + role lines", () => {
    const viewState = createMessengerViewState();
    viewState.mainView = "swarm";

    const agents: SpawnedAgent[] = [
      {
        id: "a1",
        cwd: "/tmp",
        name: "QuickHawk",
        role: "Researcher",
        objective: "Investigate API limits",
        status: "running",
        startedAt: new Date().toISOString(),
      },
      {
        id: "a2",
        cwd: "/tmp",
        name: "SwiftOtter",
        role: "Implementer",
        objective: "Ship patch",
        status: "completed",
        startedAt: new Date().toISOString(),
      },
    ];

    const lines = renderSwarmList(theme as any, agents, 120, 4, viewState);

    expect(lines[0]).toContain("QuickHawk");
    expect(lines[0]).toContain("Researcher");
    expect(lines[1]).toContain("SwiftOtter");
    expect(lines[1]).toContain("Implementer");
  });

  it("shows f:Tasks legend in swarm list mode", () => {
    const viewState = createMessengerViewState();
    viewState.mainView = "swarm";

    const legend = renderLegend(
      theme as any,
      "/tmp",
      120,
      viewState,
      null,
      {
        id: "a1",
        cwd: "/tmp",
        name: "QuickHawk",
        role: "Researcher",
        objective: "Investigate",
        status: "running",
        startedAt: new Date().toISOString(),
      },
    );

    expect(legend).toContain("f:Tasks");
    expect(legend).toContain("Enter:Detail");
  });
});
