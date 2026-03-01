import { randomUUID } from "node:crypto";
import { matchesKey, type TUI } from "@mariozechner/pi-tui";
import type { AgentMailMessage, Dirs, MessengerState } from "./lib.js";
import { MAX_CHAT_HISTORY } from "./lib.js";
import { sendMessageToAgent, getActiveAgents } from "./store.js";
import { logFeedEvent, type FeedEvent } from "./feed.js";
import * as swarmStore from "./swarm/store.js";
import { executeTaskAction as runTaskAction } from "./swarm/task-actions.js";
import type { SwarmTask as Task } from "./swarm/types.js";
import { getLiveWorkers } from "./swarm/live-progress.js";

interface ConfirmAction {
  type: "reset" | "cascade-reset" | "delete" | "archive";
  taskId: string;
  label: string;
}

export interface MessengerViewState {
  scrollOffset: number;
  selectedTaskIndex: number;
  selectedSwarmIndex: number;
  swarmScrollOffset: number;
  mainView: "tasks" | "swarm";
  mode: "list" | "detail";
  detailScroll: number;
  detailAutoScroll: boolean;
  confirmAction: ConfirmAction | null;
  blockReasonInput: string;
  messageInput: string;
  inputMode: "normal" | "block-reason" | "message";
  lastSeenEventTs: string | null;
  notification: { message: string; expiresAt: number } | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  feedScrollOffset: number;
  mentionCandidates: string[];
  mentionIndex: number;
  pendingG: boolean;
  expandFeedMessages: boolean;
  // Progressive feed loading
  feedLoadedEvents: FeedEvent[];
  feedLoadedOffset: number; // offset from end (0 = all loaded, N = last N lines not yet loaded)
  feedTotalLines: number;
}

export function createMessengerViewState(): MessengerViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
    selectedSwarmIndex: 0,
    swarmScrollOffset: 0,
    mainView: "tasks",
    mode: "list",
    detailScroll: 0,
    detailAutoScroll: true,
    confirmAction: null,
    blockReasonInput: "",
    messageInput: "",
    inputMode: "normal",
    lastSeenEventTs: null,
    notification: null,
    notificationTimer: null,
    feedScrollOffset: 0,
    mentionCandidates: [],
    mentionIndex: -1,
    pendingG: false,
    expandFeedMessages: false,
    // Progressive feed loading - start empty, will load initial batch on first render
    feedLoadedEvents: [],
    feedLoadedOffset: 0,
    feedTotalLines: 0,
  };
}

function hasLiveWorker(cwd: string, taskId: string): boolean {
  return getLiveWorkers(cwd).has(taskId);
}

function isPrintable(data: string): boolean {
  return data.length > 0 && data.charCodeAt(0) >= 32;
}

function executeTaskAction(
  cwd: string,
  action: string,
  taskId: string,
  agentName: string,
  reason?: string,
): { success: boolean; message: string } {
  if (
    action !== "start" &&
    action !== "block" &&
    action !== "unblock" &&
    action !== "reset" &&
    action !== "cascade-reset" &&
    action !== "delete" &&
    action !== "archive" &&
    action !== "stop"
  ) {
    return { success: false, message: `Unknown action: ${action}` };
  }

  const result = runTaskAction(cwd, action, taskId, agentName, reason, {
    isWorkerActive: id => hasLiveWorker(cwd, id),
  });
  return { success: result.success, message: result.message };
}

export function setNotification(viewState: MessengerViewState, tui: TUI, success: boolean, message: string): void {
  if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  viewState.notification = { message: `${success ? "✓" : "✗"} ${message}`, expiresAt: Date.now() + 2000 };
  viewState.notificationTimer = setTimeout(() => {
    viewState.notificationTimer = null;
    tui.requestRender();
  }, 2000);
}

function addToChatHistory(state: MessengerState, recipient: string, message: AgentMailMessage): void {
  let history = state.chatHistory.get(recipient);
  if (!history) {
    history = [];
    state.chatHistory.set(recipient, history);
  }
  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) history.shift();
}

function addToBroadcastHistory(state: MessengerState, text: string): void {
  const broadcastMsg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to: "broadcast",
    text,
    timestamp: new Date().toISOString(),
    replyTo: null,
  };
  state.broadcastHistory.push(broadcastMsg);
  if (state.broadcastHistory.length > MAX_CHAT_HISTORY) {
    state.broadcastHistory.shift();
  }
}

function previewText(text: string): string {
  return text;
}

export function handleConfirmInput(data: string, viewState: MessengerViewState, cwd: string, agentName: string, tui: TUI): void {
  const action = viewState.confirmAction;
  if (!action) return;
  if (matchesKey(data, "y")) {
    const result = executeTaskAction(cwd, action.type, action.taskId, agentName);
    if (action.type === "delete" || action.type === "archive") {
      const tasks = swarmStore.getTasks(cwd);
      if (tasks.length > 0) {
        viewState.selectedTaskIndex = Math.max(0, Math.min(viewState.selectedTaskIndex, tasks.length - 1));
      } else {
        viewState.selectedTaskIndex = 0;
        if (viewState.mode === "detail") viewState.mode = "list";
      }
    }
    viewState.confirmAction = null;
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "n") || matchesKey(data, "escape")) {
    viewState.confirmAction = null;
    tui.requestRender();
  }
}

export function handleBlockReasonInput(
  data: string,
  viewState: MessengerViewState,
  cwd: string,
  task: Task | undefined,
  agentName: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    viewState.inputMode = "normal";
    viewState.blockReasonInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "enter")) {
    const reason = viewState.blockReasonInput.trim();
    if (!reason || !task) return;
    const result = executeTaskAction(cwd, "block", task.id, agentName, reason);
    viewState.inputMode = "normal";
    viewState.blockReasonInput = "";
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "backspace")) {
    if (viewState.blockReasonInput.length > 0) {
      viewState.blockReasonInput = viewState.blockReasonInput.slice(0, -1);
      tui.requestRender();
    }
    return;
  }
  if (isPrintable(data)) {
    viewState.blockReasonInput += data;
    tui.requestRender();
  }
}

function resetMessageInput(viewState: MessengerViewState): void {
  viewState.inputMode = "normal";
  viewState.messageInput = "";
  viewState.mentionCandidates = [];
  viewState.mentionIndex = -1;
}

function collectMentionCandidates(
  prefix: string,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const agent of getActiveAgents(state, dirs)) {
    if (agent.name === state.agentName) continue;
    if (!seen.has(agent.name)) {
      seen.add(agent.name);
      names.push(agent.name);
    }
  }

  for (const worker of getLiveWorkers(cwd).values()) {
    if (!seen.has(worker.name)) {
      seen.add(worker.name);
      names.push(worker.name);
    }
  }

  names.push("all");

  if (!prefix) return names;
  const lower = prefix.toLowerCase();
  return names.filter(n => n.toLowerCase().startsWith(lower));
}

function sendDirectMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  target: string,
  text: string,
  tui: TUI,
  viewState: MessengerViewState,
): void {
  try {
    const msg = sendMessageToAgent(state, dirs, target, text);
    addToChatHistory(state, target, msg);
    logFeedEvent(cwd, state.agentName, "message", target, previewText(text));
    resetMessageInput(viewState);
    setNotification(viewState, tui, true, `Sent to ${target}`);
    tui.requestRender();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    setNotification(viewState, tui, false, `Failed to send to ${target}: ${msg}`);
    tui.requestRender();
  }
}

function sendBroadcastMessage(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  text: string,
  tui: TUI,
  viewState: MessengerViewState,
): void {
  const peers = getActiveAgents(state, dirs);

  let sentCount = 0;
  for (const peer of peers) {
    try {
      sendMessageToAgent(state, dirs, peer.name, text);
      sentCount++;
    } catch {
      // Ignore per-recipient failures
    }
  }

  // If no peers are active, treat chat input as local steering.
  if (sentCount === 0) {
    try {
      const selfMsg = sendMessageToAgent(state, dirs, state.agentName, text);
      addToChatHistory(state, state.agentName, selfMsg);
      addToBroadcastHistory(state, text);
      logFeedEvent(cwd, state.agentName, "message", "self", previewText(text));
      resetMessageInput(viewState);
      setNotification(viewState, tui, true, "Steered current agent (no peers)");
      tui.requestRender();
      return;
    } catch {
      setNotification(viewState, tui, false, "Broadcast/steer failed");
      tui.requestRender();
      return;
    }
  }

  addToBroadcastHistory(state, text);
  logFeedEvent(cwd, state.agentName, "message", undefined, previewText(text));
  resetMessageInput(viewState);
  setNotification(viewState, tui, true, `Broadcast to ${sentCount} peer${sentCount === 1 ? "" : "s"}`);
  tui.requestRender();
}

export function handleMessageInput(
  data: string,
  viewState: MessengerViewState,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  tui: TUI,
): void {
  if (matchesKey(data, "escape")) {
    resetMessageInput(viewState);
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    const input = viewState.messageInput;
    const cycling = viewState.mentionIndex >= 0 && viewState.mentionCandidates.length > 0;
    if (!input.startsWith("@") || (input.includes(" ") && !cycling)) return;

    const reverse = matchesKey(data, "shift+tab");

    if (!cycling) {
      const prefix = input.slice(1);
      viewState.mentionCandidates = collectMentionCandidates(prefix, state, dirs, cwd);
      if (viewState.mentionCandidates.length === 0) return;
      viewState.mentionIndex = 0;
    } else {
      const delta = reverse ? -1 : 1;
      viewState.mentionIndex = (viewState.mentionIndex + delta + viewState.mentionCandidates.length) % viewState.mentionCandidates.length;
    }

    viewState.messageInput = `@${viewState.mentionCandidates[viewState.mentionIndex]} `;
    tui.requestRender();
    return;
  }

  if (matchesKey(data, "enter")) {
    const raw = viewState.messageInput.trim();
    if (!raw) return;

    if (raw.startsWith("@all ")) {
      const text = raw.slice(5).trim();
      if (!text) return;
      sendBroadcastMessage(state, dirs, cwd, text, tui, viewState);
      return;
    }

    if (raw.startsWith("@")) {
      const firstSpace = raw.indexOf(" ");
      if (firstSpace <= 1) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      const target = raw.slice(1, firstSpace).trim();
      const text = raw.slice(firstSpace + 1).trim();
      if (!target || !text) {
        setNotification(viewState, tui, false, "Use @name <message> or type to broadcast");
        tui.requestRender();
        return;
      }

      sendDirectMessage(state, dirs, cwd, target, text, tui, viewState);
      return;
    }

    sendBroadcastMessage(state, dirs, cwd, raw, tui, viewState);
    return;
  }

  if (matchesKey(data, "backspace")) {
    if (viewState.messageInput.length > 0) {
      viewState.messageInput = viewState.messageInput.slice(0, -1);
      viewState.mentionCandidates = [];
      viewState.mentionIndex = -1;
      tui.requestRender();
    }
    return;
  }

  if (isPrintable(data)) {
    viewState.messageInput += data;
    viewState.mentionCandidates = [];
    viewState.mentionIndex = -1;
    tui.requestRender();
  }
}

export function handleTaskKeyBinding(
  data: string,
  task: Task,
  viewState: MessengerViewState,
  cwd: string,
  agentName: string,
  tui: TUI,
): void {
  if (matchesKey(data, "s") && task.status === "todo") {
    const result = executeTaskAction(cwd, "start", task.id, agentName);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "u") && task.status === "blocked") {
    const result = executeTaskAction(cwd, "unblock", task.id, agentName);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "b") && task.status === "in_progress") {
    viewState.inputMode = "block-reason";
    viewState.blockReasonInput = "";
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "q") && task.status === "in_progress") {
    const result = executeTaskAction(cwd, "stop", task.id, agentName);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, "x")) {
    if (task.status !== "done") {
      setNotification(viewState, tui, false, "Only done tasks can be archived");
      tui.requestRender();
      return;
    }
    viewState.confirmAction = { type: "archive", taskId: task.id, label: task.title };
    tui.requestRender();
    return;
  }
}
