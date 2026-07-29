import { randomUUID } from 'node:crypto';
import { matchesKey, type TUI } from '@earendil-works/pi-tui';
import type { AgentMailMessage, Dirs, MessengerState } from '../lib.js';
import { MAX_CHAT_HISTORY, isProcessAlive } from '../lib.js';
import { getActiveAgents } from '../store.js';
import { agentNameToChannelId } from '../channel.js';
import { logFeedEvent, type FeedEvent } from '../feed/index.js';
import * as taskStore from '../swarm/task-store.js';
import { executeTaskAction as runTaskAction } from '../swarm/task-actions.js';
import type { SwarmTask as Task } from '../swarm/types.js';
import { getLiveWorkers } from '../swarm/live-progress.js';

// Throttle render requests during typing to reduce lag
// This coalesces multiple keystrokes into a single render
const RENDER_THROTTLE_MS = 16; // ~60fps, enough for smooth typing without blocking
const renderTimers = new WeakMap<TUI, ReturnType<typeof setTimeout>>();

function requestRenderThrottled(tui: TUI): void {
  const existing = renderTimers.get(tui);
  if (existing) {
    // Already scheduled, don't queue another
    return;
  }
  const timer = setTimeout(() => {
    renderTimers.delete(tui);
    tui.requestRender();
  }, RENDER_THROTTLE_MS);
  renderTimers.set(tui, timer);
}

export interface ConfirmAction {
  type: 'delete' | 'archive';
  taskId: string;
  label: string;
}

export interface MessengerViewState {
  scrollOffset: number;
  selectedTaskIndex: number;
  selectedSwarmIndex: number;
  swarmScrollOffset: number;
  mainView: 'tasks' | 'swarm';
  mode: 'list' | 'detail';
  detailScroll: number;
  detailAutoScroll: boolean;
  confirmAction: ConfirmAction | null;
  blockReasonInput: string;
  messageInput: string;
  inputMode: 'normal' | 'block-reason' | 'message';
  lastSeenEventTs: string | null;
  notification: { message: string; expiresAt: number } | null;
  notificationTimer: ReturnType<typeof setTimeout> | null;
  mentionCandidates: string[];
  mentionIndex: number;
  pendingG: boolean;
  expandFeedMessages: boolean;
  // Progressive feed loading - sparse sliding window
  feedLoadedEvents: FeedEvent[];
  feedWindowStart: number; // absolute line index (0 = oldest, totalLines-1 = newest)
  feedWindowEnd: number; // absolute line index
  feedTotalLines: number;
  // Line-based feed scroll state
  feedLineScrollOffset: number; // lines from bottom (0 = at bottom, >0 = scrolled up)
  wasAtBottom: boolean; // track if we were at bottom before new events arrive
}

export function createMessengerViewState(): MessengerViewState {
  return {
    scrollOffset: 0,
    selectedTaskIndex: 0,
    selectedSwarmIndex: 0,
    swarmScrollOffset: 0,
    mainView: 'tasks',
    mode: 'list',
    detailScroll: 0,
    detailAutoScroll: true,
    confirmAction: null,
    blockReasonInput: '',
    messageInput: '',
    inputMode: 'normal',
    lastSeenEventTs: null,
    notification: null,
    notificationTimer: null,
    mentionCandidates: [],
    mentionIndex: -1,
    pendingG: false,
    expandFeedMessages: false,
    // Progressive feed loading - sparse window, initially empty
    feedLoadedEvents: [],
    feedWindowStart: 0,
    feedWindowEnd: 0,
    feedTotalLines: 0,
    // Line-based feed scroll
    feedLineScrollOffset: 0, // Start at bottom
    wasAtBottom: true,
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
  sessionId: string,
  action: string,
  taskId: string,
  agentName: string,
  channelId: string,
  reason?: string
): { success: boolean; message: string } {
  if (
    action !== 'start' &&
    action !== 'block' &&
    action !== 'unblock' &&
    action !== 'delete' &&
    action !== 'archive' &&
    action !== 'stop'
  ) {
    return { success: false, message: `Unknown action: ${action}` };
  }

  const result = runTaskAction(cwd, sessionId, action, taskId, agentName, channelId, reason, {
    isWorkerActive: (id) => hasLiveWorker(cwd, id),
  });
  return { success: result.success, message: result.message };
}

export function setNotification(
  viewState: MessengerViewState,
  tui: TUI,
  success: boolean,
  message: string
): void {
  if (viewState.notificationTimer) clearTimeout(viewState.notificationTimer);
  viewState.notification = {
    message: `${success ? '✓' : '✗'} ${message}`,
    expiresAt: Date.now() + 2000,
  };
  viewState.notificationTimer = setTimeout(() => {
    viewState.notificationTimer = null;
    tui.requestRender();
  }, 2000);
}

function addToChatHistory(
  state: MessengerState,
  recipient: string,
  message: AgentMailMessage
): void {
  let history = state.chatHistory.get(recipient);
  if (!history) {
    history = [];
    state.chatHistory.set(recipient, history);
  }
  history.push(message);
  if (history.length > MAX_CHAT_HISTORY) history.shift();
}

function addToChannelPostHistory(state: MessengerState, text: string): void {
  const channelPostMsg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to: state.currentChannel,
    text,
    timestamp: new Date().toISOString(),
    replyTo: null,
    channel: state.currentChannel,
  };
  state.channelPostHistory.push(channelPostMsg);
  if (state.channelPostHistory.length > MAX_CHAT_HISTORY) {
    state.channelPostHistory.shift();
  }
}

function previewText(text: string): string {
  return text;
}

export function handleConfirmInput(
  data: string,
  viewState: MessengerViewState,
  cwd: string,
  agentName: string,
  channelId: string,
  sessionId: string,
  tui: TUI
): void {
  const action = viewState.confirmAction;
  if (!action) return;
  if (matchesKey(data, 'y')) {
    const result = executeTaskAction(
      cwd,
      sessionId,
      action.type,
      action.taskId,
      agentName,
      channelId
    );
    if (action.type === 'delete' || action.type === 'archive') {
      const tasks = taskStore.getTasks(cwd, sessionId);
      if (tasks.length > 0) {
        viewState.selectedTaskIndex = Math.max(
          0,
          Math.min(viewState.selectedTaskIndex, tasks.length - 1)
        );
      } else {
        viewState.selectedTaskIndex = 0;
        if (viewState.mode === 'detail') viewState.mode = 'list';
      }
    }
    viewState.confirmAction = null;
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, 'n') || matchesKey(data, 'escape')) {
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
  channelId: string,
  sessionId: string,
  tui: TUI
): void {
  if (matchesKey(data, 'escape')) {
    viewState.inputMode = 'normal';
    viewState.blockReasonInput = '';
    tui.requestRender();
    return;
  }
  if (matchesKey(data, 'enter')) {
    const reason = viewState.blockReasonInput.trim();
    if (!reason || !task) return;
    const result = executeTaskAction(
      cwd,
      sessionId,
      'block',
      task.id,
      agentName,
      channelId,
      reason
    );
    viewState.inputMode = 'normal';
    viewState.blockReasonInput = '';
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, 'backspace')) {
    if (viewState.blockReasonInput.length > 0) {
      viewState.blockReasonInput = viewState.blockReasonInput.slice(0, -1);
      requestRenderThrottled(tui);
    }
    return;
  }
  if (isPrintable(data)) {
    viewState.blockReasonInput += data;
    requestRenderThrottled(tui);
  }
}

function resetMessageInput(viewState: MessengerViewState): void {
  viewState.inputMode = 'normal';
  viewState.messageInput = '';
  viewState.mentionCandidates = [];
  viewState.mentionIndex = -1;
}

export function collectChannelCandidates(
  prefix: string,
  state: MessengerState,
  dirs: Dirs,
  cwd: string
): string[] {
  const seen = new Set<string>();
  const channels: string[] = [];

  // Compute the current agent's channelId so we can exclude it from
  // autocomplete in both the agents and live-workers loops. We use the
  // channelId form (e.g. "iron-eagle") rather than the raw name because
  // that is what gets pushed into the candidates list, and because the
  // name-equality check can silently miss if agentName isn't set yet.
  const myChannelId = state.agentName
    ? agentNameToChannelId(state.agentName) || state.agentName.toLowerCase()
    : null;

  // For autocomplete discovery, show ALL live agents regardless of project folder.
  // scopeToFolder is for task/feed isolation, not peer discovery — cross-project
  // agents should be visible so users can send messages to them via #agentName.
  const discoveryState = state.scopeToFolder ? { ...state, scopeToFolder: false } : state;

  // gc:false — autocomplete reads should not delete registry files for dead peers.
  // A peer whose process just died should remain discoverable until the harness
  // cleans up its own lifecycle; doing GC here would race with the harness.
  for (const agent of getActiveAgents(discoveryState, dirs, { gc: false })) {
    if (agent.name === state.agentName) continue;
    const channelId = agentNameToChannelId(agent.name) || agent.name.toLowerCase();
    if (myChannelId && channelId === myChannelId) continue;
    if (!seen.has(channelId)) {
      seen.add(channelId);
      channels.push(channelId);
    }
  }

  for (const worker of getLiveWorkers(cwd).values()) {
    // Skip workers whose process has died without calling removeLiveWorker
    // (e.g. crash before cleanup). Workers with no pid are legacy entries —
    // treat them as alive for backward compatibility.
    if (worker.pid !== undefined && !isProcessAlive(worker.pid)) continue;
    const channelId = agentNameToChannelId(worker.name) || worker.name.toLowerCase();
    // Exclude the current session — it makes no sense to send a message to yourself.
    if (myChannelId && channelId === myChannelId) continue;
    if (!seen.has(channelId)) {
      seen.add(channelId);
      channels.push(channelId);
    }
  }

  channels.push('all');

  if (!prefix) return channels;
  const lower = prefix.toLowerCase();
  return channels.filter((ch) => ch.toLowerCase().startsWith(lower));
}

function sendToChannel(
  state: MessengerState,
  _dirs: Dirs,
  cwd: string,
  channelId: string,
  text: string,
  tui: TUI,
  viewState: MessengerViewState
): void {
  try {
    // Log to feed in the target channel - all messaging is feed-based
    logFeedEvent(cwd, state.agentName, 'message', undefined, previewText(text), channelId);
    resetMessageInput(viewState);
    setNotification(viewState, tui, true, `Posted to #${channelId}`);
    tui.requestRender();
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    setNotification(viewState, tui, false, `Failed to send: ${msg}`);
    tui.requestRender();
  }
}

function sendChannelPost(
  state: MessengerState,
  _dirs: Dirs,
  cwd: string,
  text: string,
  tui: TUI,
  viewState: MessengerViewState
): void {
  // All messaging is now feed-based - no inbox delivery
  addToChannelPostHistory(state, text);
  logFeedEvent(cwd, state.agentName, 'message', undefined, previewText(text), state.currentChannel);
  resetMessageInput(viewState);
  const channelLabel = state.currentChannel.startsWith('#')
    ? state.currentChannel
    : `#${state.currentChannel}`;
  setNotification(viewState, tui, true, `Posted to ${channelLabel}`);
  tui.requestRender();
}

export function handleMessageInput(
  data: string,
  viewState: MessengerViewState,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  tui: TUI
): void {
  if (matchesKey(data, 'escape')) {
    resetMessageInput(viewState);
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
    const input = viewState.messageInput;
    const cycling = viewState.mentionIndex >= 0 && viewState.mentionCandidates.length > 0;
    if (!input.startsWith('#') || (input.includes(' ') && !cycling)) return;

    const reverse = matchesKey(data, 'shift+tab');

    if (!cycling) {
      const prefix = input.slice(1);
      viewState.mentionCandidates = collectChannelCandidates(prefix, state, dirs, cwd);
      if (viewState.mentionCandidates.length === 0) return;
      viewState.mentionIndex = 0;
    } else {
      const delta = reverse ? -1 : 1;
      viewState.mentionIndex =
        (viewState.mentionIndex + delta + viewState.mentionCandidates.length) %
        viewState.mentionCandidates.length;
    }

    viewState.messageInput = `#${viewState.mentionCandidates[viewState.mentionIndex]} `;
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'enter')) {
    const raw = viewState.messageInput.trim();
    if (!raw) return;

    if (raw.startsWith('#all ')) {
      const text = raw.slice(5).trim();
      if (!text) return;
      sendChannelPost(state, dirs, cwd, text, tui, viewState);
      return;
    }

    if (raw.startsWith('#')) {
      const firstSpace = raw.indexOf(' ');
      if (firstSpace <= 1) {
        setNotification(
          viewState,
          tui,
          false,
          'Use #channel <message> or type to post to the current channel'
        );
        tui.requestRender();
        return;
      }

      const channelId = raw.slice(1, firstSpace).trim();
      const text = raw.slice(firstSpace + 1).trim();
      if (!channelId || !text) {
        setNotification(
          viewState,
          tui,
          false,
          'Use #channel <message> or type to post to the current channel'
        );
        tui.requestRender();
        return;
      }

      sendToChannel(state, dirs, cwd, channelId, text, tui, viewState);
      return;
    }

    sendChannelPost(state, dirs, cwd, raw, tui, viewState);
    return;
  }

  if (matchesKey(data, 'backspace')) {
    if (viewState.messageInput.length > 0) {
      viewState.messageInput = viewState.messageInput.slice(0, -1);
      viewState.mentionCandidates = [];
      viewState.mentionIndex = -1;
      requestRenderThrottled(tui);
    }
    return;
  }

  if (isPrintable(data)) {
    viewState.messageInput += data;
    viewState.mentionCandidates = [];
    viewState.mentionIndex = -1;
    requestRenderThrottled(tui);
  }
}

export function handleTaskKeyBinding(
  data: string,
  task: Task,
  viewState: MessengerViewState,
  cwd: string,
  agentName: string,
  channelId: string,
  sessionId: string,
  tui: TUI
): void {
  if (matchesKey(data, 'u') && task.status === 'blocked') {
    const result = executeTaskAction(cwd, sessionId, 'unblock', task.id, agentName, channelId);
    setNotification(viewState, tui, result.success, result.message);
    tui.requestRender();
    return;
  }
  if (matchesKey(data, 'b') && task.status === 'in_progress') {
    viewState.inputMode = 'block-reason';
    viewState.blockReasonInput = '';
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'x')) {
    if (task.status !== 'done') {
      setNotification(viewState, tui, false, 'Only done tasks can be archived');
      tui.requestRender();
      return;
    }
    viewState.confirmAction = { type: 'archive', taskId: task.id, label: task.title };
    tui.requestRender();
    return;
  }
}
