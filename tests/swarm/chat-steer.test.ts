import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-tui", () => ({
  matchesKey: (data: string, key: string) => {
    if (key === "escape") return data === "\x1b";
    if (key === "enter") return data === "\r";
    if (key === "backspace") return data === "\x7f" || data === "\b";
    if (key === "tab") return data === "\t";
    if (key === "shift+tab") return data === "\x1b[Z";
    return false;
  },
}));

const mocks = vi.hoisted(() => ({
  sendMessageToAgent: vi.fn(),
  getActiveAgents: vi.fn(),
}));

vi.mock("../../store.js", () => ({
  sendMessageToAgent: mocks.sendMessageToAgent,
  getActiveAgents: mocks.getActiveAgents,
}));

vi.mock("../../crew/live-progress.js", () => ({
  getLiveWorkers: () => new Map(),
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));

vi.mock("../../feed.js", () => ({
  logFeedEvent: vi.fn(),
}));

vi.mock("../../swarm/task-actions.js", () => ({
  executeTaskAction: () => ({ success: true, message: "ok" }),
}));

vi.mock("../../crew/registry.js", () => ({
  hasActiveWorker: () => false,
}));

import { createCrewViewState, handleMessageInput } from "../../overlay-actions.js";
import type { MessengerState, Dirs } from "../../lib.js";
import type { TUI } from "@mariozechner/pi-tui";

function makeState(): MessengerState {
  return { agentName: "me", scopeToFolder: false, chatHistory: new Map(), broadcastHistory: [] } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: "/tmp", registry: "/tmp/reg", inbox: "/tmp/inbox" } as Dirs;
}

function makeTui(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

describe("overlay chat steering behavior", () => {
  beforeEach(() => {
    mocks.sendMessageToAgent.mockReset();
    mocks.getActiveAgents.mockReset();
  });

  it("falls back to steering self when broadcasting with no peers", () => {
    const viewState = createCrewViewState();
    viewState.inputMode = "message";
    viewState.messageInput = "Investigate auth race";

    const state = makeState();
    const dirs = makeDirs();
    const tui = makeTui();

    mocks.getActiveAgents.mockReturnValue([]);
    mocks.sendMessageToAgent.mockImplementation((_state, _dirs, to: string, text: string) => ({
      id: "msg-1",
      from: "me",
      to,
      text,
      timestamp: new Date().toISOString(),
      replyTo: null,
    }));

    handleMessageInput("\r", viewState, state, dirs, "/tmp/cwd", tui);

    expect(mocks.sendMessageToAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "me", "Investigate auth race");
    expect(viewState.inputMode).toBe("normal");
    expect(viewState.messageInput).toBe("");
  });

  it("still broadcasts to peers when peers exist", () => {
    const viewState = createCrewViewState();
    viewState.inputMode = "message";
    viewState.messageInput = "Hello swarm";

    const state = makeState();
    const dirs = makeDirs();
    const tui = makeTui();

    mocks.getActiveAgents.mockReturnValue([{ name: "alpha" }, { name: "beta" }]);
    mocks.sendMessageToAgent.mockImplementation((_state, _dirs, to: string, text: string) => ({
      id: `${to}-id`,
      from: "me",
      to,
      text,
      timestamp: new Date().toISOString(),
      replyTo: null,
    }));

    handleMessageInput("\r", viewState, state, dirs, "/tmp/cwd", tui);

    expect(mocks.sendMessageToAgent).toHaveBeenCalledTimes(2);
    expect(mocks.sendMessageToAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "alpha", "Hello swarm");
    expect(mocks.sendMessageToAgent).toHaveBeenCalledWith(expect.anything(), expect.anything(), "beta", "Hello swarm");
  });
});
