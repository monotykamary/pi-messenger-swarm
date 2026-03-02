/**
 * Pi Messenger - Swarm Overlay Component
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  formatDuration,
  type MessengerState,
  type Dirs,
} from "./lib.js";
import * as swarmStore from "./swarm/store.js";
import { readFeedEvents, readFeedEventsWithOffset, readFeedEventsByRange, getFeedLineCount, type FeedEvent, type FeedEventType } from "./feed.js";
import type { SwarmTask as Task } from "./swarm/types.js";
import {
  renderStatusBar,
  renderWorkersSection,
  renderTaskList,
  renderSwarmList,
  renderFeedSection,
  renderAgentsRow,
  renderLegend,
  renderEmptyState,
  renderDetailView,
  renderSwarmDetail,
  navigateTask,
  navigateSwarm,
} from "./overlay-render.js";
import {
  createMessengerViewState,
  handleConfirmInput,
  handleBlockReasonInput,
  handleMessageInput,
  handleTaskKeyBinding,
  setNotification,
  type MessengerViewState,
} from "./overlay-actions.js";
import { getLiveWorkers, hasLiveWorkers, onLiveWorkersChanged } from "./swarm/live-progress.js";
import { listSpawned } from "./swarm/spawn.js";
import { loadConfig } from "./config.js";
import {
  calculateVisibleRange,
  scrollUp,
  scrollDown,
  jumpToTop,
  jumpToBottom,
  isAtBottom,
  calculateWindowForOlderLoad,
  calculateRenderedLines,
} from "./feed-scroll.js";

export interface OverlayCallbacks {
  onBackground?: (snapshot: string) => void;
}

function isFeedUpKey(data: string): boolean {
  // Vim-style: k scrolls up (to older feed items)
  return data === "k" || data === "K";
}

function isFeedDownKey(data: string): boolean {
  // Vim-style: j scrolls down (to newer feed items)
  return data === "j" || data === "J";
}

export class MessengerOverlay implements Component, Focusable {
  get width(): number {
    return Math.min(100, Math.max(40, process.stdout.columns ?? 90));
  }
  focused = false;

  private viewState: MessengerViewState = createMessengerViewState();
  private cwd: string;
  private stuckThresholdMs: number;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressUnsubscribe: (() => void) | null = null;
  private sawIncompleteWork = false;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private completionDismissed = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: (snapshot?: string) => void,
    private callbacks: OverlayCallbacks,
  ) {
    this.cwd = process.cwd();
    const cfg = loadConfig(this.cwd);
    this.stuckThresholdMs = cfg.stuckThreshold * 1000;

    for (const key of this.state.unreadCounts.keys()) {
      this.state.unreadCounts.set(key, 0);
    }

    this.progressUnsubscribe = onLiveWorkersChanged(() => {
      this.syncRefreshTimers();
      this.tui.requestRender();
    });

    this.syncRefreshTimers();
  }

  private syncRefreshTimers(): void {
    if (hasLiveWorkers(this.cwd)) this.startProgressRefresh();
    else this.stopProgressRefresh();
  }

  private startProgressRefresh(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      if (hasLiveWorkers(this.cwd)) {
        this.tui.requestRender();
      } else {
        this.stopProgressRefresh();
      }
    }, 1000);
  }

  private stopProgressRefresh(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  handleInput(data: string): void {
    this.cancelCompletionTimer();

    // Cancel pending gg if any non-g key is pressed
    if (this.viewState.pendingG && data !== "g") {
      this.viewState.pendingG = false;
    }

    // Toggle expanded feed messages - check early to ensure it works
    if (data === "e") {
      this.viewState.expandFeedMessages = !this.viewState.expandFeedMessages;
      this.tui.requestRender();
      return;
    }

    // Snapshot transfer: Ctrl+T (legacy) or Shift+T
    if (data === "\x14" || data === "T" || matchesKey(data, "shift+t")) {
      this.done(this.generateSnapshot());
      return;
    }

    // Background overlay: Ctrl+B (legacy) or Shift+B
    if (data === "\x02" || data === "B" || matchesKey(data, "shift+b")) {
      this.callbacks.onBackground?.(this.generateSnapshot());
      return;
    }

    if (this.viewState.confirmAction) {
      handleConfirmInput(data, this.viewState, this.cwd, this.state.agentName, this.tui);
      return;
    }

    if (this.viewState.inputMode === "block-reason") {
      const tasks = swarmStore.getTasks(this.cwd);
      const task = tasks[this.viewState.selectedTaskIndex];
      handleBlockReasonInput(data, this.viewState, this.cwd, task as Task | undefined, this.state.agentName, this.tui);
      return;
    }

    if (this.viewState.inputMode === "message") {
      handleMessageInput(data, this.viewState, this.state, this.dirs, this.cwd, this.tui);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.viewState.mode === "detail") {
        this.viewState.mode = "list";
        this.tui.requestRender();
      } else {
        this.done();
      }
      return;
    }

    if (data === "@" || matchesKey(data, "m")) {
      this.viewState.inputMode = "message";
      this.viewState.messageInput = data === "@" ? "@" : "";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "f")) {
      if (this.viewState.mode === "detail") {
        this.viewState.mode = "list";
      }
      this.viewState.mainView = this.viewState.mainView === "tasks" ? "swarm" : "tasks";
      this.tui.requestRender();
      return;
    }

    // Feed scrolling: j/k for line-by-line vim-style scrolling.
    // k = scroll up (to older feed items = smaller absolute index),
    // j = scroll down (to newer feed items = larger absolute index).
    // gg = jump to top (oldest, index 0), G = jump to bottom (newest).
    const totalFeedLines = getFeedLineCount(this.cwd);
    const termRows = process.stdout.rows ?? 24;
    const chromeLines = 8;
    const contentHeight = Math.max(8, termRows - chromeLines);

    // Calculate feedHeight consistently with render method (baseline before worker adjustments)
    const workersLimit = termRows <= 26 ? 2 : 5;
    const workerLines = renderWorkersSection(this.theme, this.cwd, this.width - 4, workersLimit);
    const agentsHeight = 2;
    const workersHeight = workerLines.length > 0 ? workerLines.length + 1 : 0;
    const available = contentHeight - workersHeight - agentsHeight;

    let feedHeight: number;
    // Note: tasks[] is declared later in this function, use a different variable name here
    const taskList = swarmStore.getTasks(this.cwd);
    if (this.viewState.mainView === "tasks" && taskList.length === 0) {
      const hasFeed = totalFeedLines > 0;
      if (hasFeed) {
        const mainHeight = Math.min(Math.max(2, available - 1), 4);
        feedHeight = Math.max(2, available - mainHeight - 1);
      } else {
        feedHeight = 0;
      }
    } else if (workerLines.length > 0) {
      feedHeight = Math.max(6, Math.floor(available * 0.65));
    } else {
      feedHeight = Math.max(4, Math.floor(available * 0.55));
    }

    if (isFeedUpKey(data)) {
      this.viewState.pendingG = false;
      this.viewState.wasAtBottom = false; // Manual scroll up = leave bottom
      // Line-based scroll - will recalculate based on rendered lines during render
      this.viewState.feedLineScrollOffset += 1;
      this.tui.requestRender();
      return;
    }
    if (isFeedDownKey(data)) {
      this.viewState.pendingG = false;
      // Line-based scroll down (toward bottom)
      this.viewState.feedLineScrollOffset = Math.max(0, this.viewState.feedLineScrollOffset - 1);
      this.viewState.wasAtBottom = this.viewState.feedLineScrollOffset === 0;
      this.tui.requestRender();
      return;
    }
    if (data === "g") {
      if (this.viewState.pendingG) {
        // gg = jump to top (oldest events)
        this.viewState.pendingG = false;
        this.viewState.wasAtBottom = false;

        // If there are older events not in window, load oldest window
        if (this.viewState.feedWindowStart > 0) {
          const GG_LOAD_SIZE = 100; // sparse load - only oldest 100 events
          const newStart = 0;
          const newEnd = Math.min(GG_LOAD_SIZE, this.viewState.feedTotalLines);
          const oldestEvents = readFeedEventsByRange(this.cwd, newStart, newEnd);
          this.viewState.feedLoadedEvents = oldestEvents;
          this.viewState.feedWindowStart = newStart;
          this.viewState.feedWindowEnd = newEnd;
        }

        // Jump to top - set offset to max (will be clamped during render)
        this.viewState.feedLineScrollOffset = 1000000; // Large value, will be clamped
        this.tui.requestRender();
        return;
      } else {
        this.viewState.pendingG = true;
        // Don't render, just wait for second g
        return;
      }
    }
    if (data === "G") {
      this.viewState.pendingG = false;
      // Jump to bottom
      this.viewState.feedLineScrollOffset = 0;
      this.viewState.wasAtBottom = true;
      this.tui.requestRender();
      return;
    }
    // Any other key cancels the pending gg
    if (this.viewState.pendingG) {
      this.viewState.pendingG = false;
    }

    const tasks = swarmStore.getTasks(this.cwd);
    const spawned = listSpawned(this.cwd);
    const task = tasks[this.viewState.selectedTaskIndex];
    const swarmAgent = spawned[this.viewState.selectedSwarmIndex];

    if (matchesKey(data, "right")) {
      if (this.viewState.mode === "detail") {
        if (this.viewState.mainView === "swarm") {
          navigateSwarm(this.viewState, 1, spawned.length);
          this.viewState.detailAutoScroll = false;
        } else {
          navigateTask(this.viewState, 1, tasks.length);
          this.viewState.detailAutoScroll = true;
        }
        this.viewState.detailScroll = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "left")) {
      if (this.viewState.mode === "detail") {
        if (this.viewState.mainView === "swarm") {
          navigateSwarm(this.viewState, -1, spawned.length);
          this.viewState.detailAutoScroll = false;
        } else {
          navigateTask(this.viewState, -1, tasks.length);
          this.viewState.detailAutoScroll = true;
        }
        this.viewState.detailScroll = 0;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.viewState.mode === "detail") {
        this.viewState.detailScroll = Math.max(0, this.viewState.detailScroll - 1);
        this.viewState.detailAutoScroll = false;
      } else if (this.viewState.mainView === "swarm") {
        navigateSwarm(this.viewState, -1, spawned.length);
      } else {
        navigateTask(this.viewState, -1, tasks.length);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.viewState.mode === "detail") {
        this.viewState.detailScroll++;
        this.viewState.detailAutoScroll = false;
      } else if (this.viewState.mainView === "swarm") {
        navigateSwarm(this.viewState, 1, spawned.length);
      } else {
        navigateTask(this.viewState, 1, tasks.length);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      if (this.viewState.mainView === "swarm") {
        this.viewState.selectedSwarmIndex = 0;
        this.viewState.swarmScrollOffset = 0;
      } else {
        this.viewState.selectedTaskIndex = 0;
        this.viewState.scrollOffset = 0;
      }
      if (this.viewState.mode === "detail") {
        this.viewState.detailScroll = 0;
        this.viewState.detailAutoScroll = false;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      if (this.viewState.mainView === "swarm") {
        this.viewState.selectedSwarmIndex = Math.max(0, spawned.length - 1);
      } else {
        this.viewState.selectedTaskIndex = Math.max(0, tasks.length - 1);
      }
      if (this.viewState.mode === "detail") {
        this.viewState.detailScroll = 0;
        this.viewState.detailAutoScroll = this.viewState.mainView !== "swarm";
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.viewState.mode !== "detail") {
        if (this.viewState.mainView === "swarm" && swarmAgent) {
          this.viewState.mode = "detail";
          this.viewState.detailScroll = 0;
          this.viewState.detailAutoScroll = false;
          this.tui.requestRender();
        } else if (this.viewState.mainView === "tasks" && task) {
          this.viewState.mode = "detail";
          this.viewState.detailScroll = 0;
          this.viewState.detailAutoScroll = true;
          this.tui.requestRender();
        }
      }
      return;
    }

    if (this.viewState.mode === "detail") {
      if (matchesKey(data, "[")) {
        if (this.viewState.mainView === "swarm") {
          navigateSwarm(this.viewState, -1, spawned.length);
          this.viewState.detailAutoScroll = false;
        } else {
          navigateTask(this.viewState, -1, tasks.length);
          this.viewState.detailAutoScroll = true;
        }
        this.viewState.detailScroll = 0;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "]")) {
        if (this.viewState.mainView === "swarm") {
          navigateSwarm(this.viewState, 1, spawned.length);
          this.viewState.detailAutoScroll = false;
        } else {
          navigateTask(this.viewState, 1, tasks.length);
          this.viewState.detailAutoScroll = true;
        }
        this.viewState.detailScroll = 0;
        this.tui.requestRender();
        return;
      }
    }

    if (this.viewState.mainView === "tasks" && task) {
      handleTaskKeyBinding(data, task as Task, this.viewState, this.cwd, this.state.agentName, this.tui);
    }
  }

  private snapshotIdleLabel(): string {
    const last = this.state.activity.lastActivityAt || this.state.sessionStartedAt;
    const ageMs = Math.max(0, Date.now() - new Date(last).getTime());
    return `idle ${formatDuration(ageMs)}`;
  }

  private formatTaskSnapshotLine(task: Task, liveTaskIds: Set<string>): string {
    if (task.status === "done") {
      return `${task.id} (${task.title})`;
    }
    if (task.status === "in_progress") {
      const parts = [task.title];
      if (task.claimed_by) parts.push(task.claimed_by);
      if (liveTaskIds.has(task.id)) parts.push("live");
      return `${task.id} (${parts.join(", ")})`;
    }
    if (task.status === "blocked") {
      const reason = task.blocked_reason ? ` — ${task.blocked_reason}` : "";
      return `${task.id} (${task.title}${reason})`;
    }
    if (task.depends_on.length > 0) {
      return `${task.id} (${task.title}, deps: ${task.depends_on.join(" ")})`;
    }
    return `${task.id} (${task.title})`;
  }

  private formatRecentFeedEvent(event: FeedEvent): string {
    const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (event.type === "task.done") return `${event.agent} completed ${event.target ?? "task"} (${time})`;
    if (event.type === "task.start") return `${event.agent} started ${event.target ?? "task"} (${time})`;
    if (event.type === "message") {
      const dir = event.target ? `→ ${event.target}: ` : "✦ ";
      return event.preview
        ? `${event.agent} ${dir}${event.preview} (${time})`
        : `${event.agent} ${dir.trim()} (${time})`;
    }
    if (event.target) return `${event.agent} ${event.type} ${event.target} (${time})`;
    return `${event.agent} ${event.type} (${time})`;
  }

  private generateSnapshot(): string {
    const tasks = swarmStore.getTasks(this.cwd);
    const liveWorkers = getLiveWorkers(this.cwd);

    if (tasks.length === 0) {
      return [
        "Swarm snapshot: no tasks",
        "",
        `Agents: You (${this.snapshotIdleLabel()})`,
        "",
        "Create task: pi_messenger({ action: \"task.create\", title: \"...\" })",
      ].join("\n");
    }

    const readyTasks = swarmStore.getReadyTasks(this.cwd);
    const readyIds = new Set(readyTasks.map(task => task.id));
    const liveTaskIds = new Set(Array.from(liveWorkers.keys()));
    const activeLines = Array.from(liveWorkers.values()).map(worker => {
      const activity = worker.progress.currentTool
        ? `${worker.progress.currentTool}${worker.progress.currentToolArgs ? ` ${worker.progress.currentToolArgs}` : ""}`
        : "thinking";
      return `${worker.taskId} (${worker.name}, ${activity}, ${formatDuration(Date.now() - worker.startedAt)})`;
    });

    const doneTasks = tasks.filter(task => task.status === "done");
    const inProgressTasks = tasks.filter(task => task.status === "in_progress");
    const blockedTasks = tasks.filter(task => task.status === "blocked");
    const waitingTasks = tasks.filter(task => task.status === "todo" && !readyIds.has(task.id));
    const recentEvents = readFeedEvents(this.cwd, 2);

    const lines = [
      `Swarm snapshot: ${doneTasks.length}/${tasks.length} tasks done, ${readyTasks.length} ready`,
      "",
      `Active: ${activeLines.length > 0 ? activeLines.join(", ") : "none"}`,
      `Done: ${doneTasks.length > 0 ? doneTasks.map(task => this.formatTaskSnapshotLine(task, liveTaskIds)).join(", ") : "none"}`,
      `In progress: ${inProgressTasks.length > 0 ? inProgressTasks.map(task => this.formatTaskSnapshotLine(task, liveTaskIds)).join(", ") : "none"}`,
      `Ready: ${readyTasks.length > 0 ? readyTasks.map(task => this.formatTaskSnapshotLine(task, liveTaskIds)).join(", ") : "none"}`,
      `Blocked: ${blockedTasks.length > 0 ? blockedTasks.map(task => this.formatTaskSnapshotLine(task, liveTaskIds)).join(", ") : "none"}`,
      `Waiting: ${waitingTasks.length > 0 ? waitingTasks.map(task => this.formatTaskSnapshotLine(task, liveTaskIds)).join(", ") : "none"}`,
    ];

    if (recentEvents.length > 0) {
      lines.push("");
      lines.push(`Recent: ${recentEvents.map(event => this.formatRecentFeedEvent(event)).join(", ")}`);
    }

    return lines.join("\n");
  }

  render(_width: number): string[] {
    const w = this.width;
    const innerW = w - 2;
    const sectionW = innerW - 2;
    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const sanitizeRowContent = (content: string) => content
      .replaceAll("\r", " ")
      .replaceAll("\n", " ")
      .replaceAll("\t", " ");
    const row = (content: string) => {
      const safe = truncateToWidth(sanitizeRowContent(content), sectionW);
      return border("│") + pad(" " + safe, innerW) + border("│");
    };
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");
    const sectionSeparator = this.theme.fg("dim", "─".repeat(sectionW));

    const tasks = swarmStore.getTasks(this.cwd);
    const spawned = listSpawned(this.cwd);

    if (tasks.length === 0) {
      this.viewState.selectedTaskIndex = 0;
      if (this.viewState.mainView === "tasks" && this.viewState.mode === "detail") {
        this.viewState.mode = "list";
      }
    } else {
      this.viewState.selectedTaskIndex = Math.max(0, Math.min(this.viewState.selectedTaskIndex, tasks.length - 1));
    }

    if (spawned.length === 0) {
      this.viewState.selectedSwarmIndex = 0;
      if (this.viewState.mainView === "swarm" && this.viewState.mode === "detail") {
        this.viewState.mode = "list";
      }
    } else {
      this.viewState.selectedSwarmIndex = Math.max(0, Math.min(this.viewState.selectedSwarmIndex, spawned.length - 1));
    }

    const selectedTask = tasks[this.viewState.selectedTaskIndex] ?? null;
    const selectedSwarmAgent = spawned[this.viewState.selectedSwarmIndex] ?? null;

    const lines: string[] = [];
    const titleContent = this.renderTitleContent();
    const titleText = ` ${titleContent} `;
    const titleLen = visibleWidth(titleContent) + 2;
    const borderLen = Math.max(0, innerW - titleLen);
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;

    lines.push(border("╭" + "─".repeat(leftBorder)) + titleText + border("─".repeat(rightBorder) + "╮"));
    lines.push(row(renderStatusBar(this.theme, this.cwd, sectionW)));
    lines.push(emptyRow());

    // Calculate legend first to determine dynamic chrome lines
    const legendLines = renderLegend(this.theme, this.cwd, sectionW, this.viewState, selectedTask as Task | null, selectedSwarmAgent);
    const chromeLines = 5 + legendLines.length; // title + status + empty row + separator + bottom border + legend lines
    const termRows = process.stdout.rows ?? 24;
    const contentHeight = Math.max(8, termRows - chromeLines);

    // Progressive feed loading with sparse sliding window
    const WINDOW_SIZE = 200; // max events to keep in memory
    const LOAD_CHUNK = 100;  // events to load when scrolling beyond window
    const totalFeedLines = getFeedLineCount(this.cwd);

    // Calculate feed height consistently (must match the calculation in list mode below)
    const workersLimit = termRows <= 26 ? 2 : 5;
    const workerLines = renderWorkersSection(this.theme, this.cwd, sectionW, workersLimit);
    const agentsHeight = 2;
    const workersHeight = () => workerLines.length > 0 ? workerLines.length + 1 : 0;
    const available = contentHeight - workersHeight() - agentsHeight;

    let feedHeight: number;
    let mainHeight: number;

    if (this.viewState.mainView === "tasks" && tasks.length === 0) {
      const hasFeed = totalFeedLines > 0;
      if (hasFeed) {
        mainHeight = Math.min(Math.max(2, available - 1), 4);
        feedHeight = Math.max(2, available - mainHeight - 1);
      } else {
        mainHeight = Math.min(10, Math.max(5, available));
        feedHeight = 0;
      }
    } else if (workerLines.length > 0) {
      feedHeight = Math.max(6, Math.floor(available * 0.65));
      mainHeight = available - feedHeight - 1;
    } else {
      feedHeight = Math.max(4, Math.floor(available * 0.55));
      mainHeight = available - feedHeight - 1;
    }

    feedHeight = Math.max(0, feedHeight);
    mainHeight = Math.max(2, mainHeight);

    // Initialize window if empty and feed exists
    if (this.viewState.feedLoadedEvents.length === 0 && totalFeedLines > 0) {
      const startIdx = Math.max(0, totalFeedLines - WINDOW_SIZE);
      const endIdx = totalFeedLines;
      this.viewState.feedLoadedEvents = readFeedEventsByRange(this.cwd, startIdx, endIdx);
      this.viewState.feedWindowStart = startIdx;
      this.viewState.feedWindowEnd = endIdx;
      this.viewState.feedTotalLines = totalFeedLines;
      // Start at bottom (lineScrollOffset = 0 means at bottom)
      this.viewState.feedLineScrollOffset = 0;
      this.viewState.wasAtBottom = true;
    } else if (totalFeedLines > this.viewState.feedTotalLines) {
      // New events added: extend window at the end
      const addedCount = totalFeedLines - this.viewState.feedTotalLines;
      const newEvents = readFeedEventsByRange(this.cwd, this.viewState.feedTotalLines, totalFeedLines);
      this.viewState.feedLoadedEvents = [...this.viewState.feedLoadedEvents, ...newEvents];

      // Track if we were at bottom before the window potentially slides
      const wasAtBottomBefore = this.viewState.wasAtBottom;

      // Trim if exceeding window size (remove from start/old end)
      let toRemove = 0;
      if (this.viewState.feedLoadedEvents.length > WINDOW_SIZE) {
        toRemove = this.viewState.feedLoadedEvents.length - WINDOW_SIZE;
        this.viewState.feedLoadedEvents = this.viewState.feedLoadedEvents.slice(toRemove);
        this.viewState.feedWindowStart += toRemove;
      }
      this.viewState.feedWindowEnd = totalFeedLines;
      this.viewState.feedTotalLines = totalFeedLines;

      // Handle scroll position: if at bottom, stay at bottom; else maintain position
      if (wasAtBottomBefore) {
        this.viewState.feedLineScrollOffset = 0; // Track to bottom
      }
      // If scrolled up, lineScrollOffset stays the same (view stays locked)
    }

    const allEvents = this.viewState.feedLoadedEvents;
    // Initialize lastSeenEventTs on first render so existing events appear dim, not highlighted
    if (this.viewState.lastSeenEventTs === null && allEvents.length > 0) {
      this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
    }
    const prevTs = this.viewState.lastSeenEventTs;
    this.detectAndFlashEvents(allEvents, prevTs);
    this.checkCompletion(tasks);

    let contentLines: string[];
    if (this.viewState.mode === "detail") {
      if (this.viewState.mainView === "swarm" && selectedSwarmAgent) {
        contentLines = renderSwarmDetail(selectedSwarmAgent, sectionW, contentHeight, this.viewState);
      } else if (this.viewState.mainView === "tasks" && selectedTask) {
        contentLines = renderDetailView(this.cwd, selectedTask as Task, sectionW, contentHeight, this.viewState);
      } else {
        contentLines = [];
        while (contentLines.length < contentHeight) contentLines.push("");
      }
    } else {
      const agentsLine = renderAgentsRow(this.cwd, sectionW, this.state, this.dirs, this.stuckThresholdMs);

      // Adjust heights based on list panel content (may increase feedHeight)
      const isListPanel = this.viewState.mainView === "swarm" || tasks.length > 0;
      if (isListPanel) {
        const listContentHeight = this.viewState.mainView === "swarm"
          ? Math.max(2, spawned.length)
          : Math.max(2, tasks.length);
        if (listContentHeight < mainHeight) {
          const surplus = mainHeight - listContentHeight;
          feedHeight += surplus;
          mainHeight = listContentHeight;
        }
      }

      // No need to re-clamp lineScrollOffset - it will be clamped during visible range calculation

      // Calculate visible range using LINE-BASED scroll offset
      // This accounts for multi-line events (messages, etc.)
      const rangeResult = calculateVisibleRange(
        this.viewState.feedLoadedEvents,
        this.theme,
        sectionW,
        prevTs,
        this.viewState.expandFeedMessages,
        this.viewState.feedLineScrollOffset,
        feedHeight,
        this.viewState.feedWindowStart,
        totalFeedLines
      );

      // Update wasAtBottom tracking based on actual position
      this.viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
      
      // Clamp the scroll offset to valid range (in case it was too large)
      this.viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;

      // Get the visible lines to display
      let feedLines = rangeResult.visibleLines;

      // Progressive loading: if we need older events, load them and recalculate
      if (rangeResult.needsOlderLoad && this.viewState.feedWindowStart > 0) {
        const { newWindowStart, newWindowEnd } = calculateWindowForOlderLoad(
          this.viewState.feedWindowStart,
          this.viewState.feedWindowEnd,
          LOAD_CHUNK,
          WINDOW_SIZE,
          totalFeedLines
        );

        const olderEvents = readFeedEventsByRange(this.cwd, newWindowStart, this.viewState.feedWindowStart);
        if (olderEvents.length > 0) {
          this.viewState.feedLoadedEvents = [...olderEvents, ...this.viewState.feedLoadedEvents];
          this.viewState.feedWindowStart = newWindowStart;
          this.viewState.feedWindowEnd = newWindowEnd;
          
          // Recalculate with new events loaded
          const newRange = calculateVisibleRange(
            this.viewState.feedLoadedEvents,
            this.theme,
            sectionW,
            prevTs,
            this.viewState.expandFeedMessages,
            this.viewState.feedLineScrollOffset,
            feedHeight,
            this.viewState.feedWindowStart,
            totalFeedLines
          );
          
          // Use the recalculated visible lines
          feedLines = newRange.visibleLines;
        }
      }

      while (workerLines.length > 0 && workersHeight() + mainHeight + (feedLines.length > 0 ? feedLines.length + 1 : 0) + agentsHeight > contentHeight) {
        workerLines = workerLines.slice(0, workerLines.length - 1);
      }

      let mainLines: string[];
      if (this.viewState.mainView === "swarm") {
        mainLines = renderSwarmList(this.theme, spawned, sectionW, mainHeight, this.viewState);
      } else if (tasks.length === 0) {
        mainLines = renderEmptyState(this.theme, this.cwd, sectionW, mainHeight);
      } else {
        mainLines = renderTaskList(this.theme, this.cwd, sectionW, mainHeight, this.viewState);
      }

      contentLines = [];
      contentLines.push(agentsLine);
      contentLines.push(sectionSeparator);

      if (workerLines.length > 0) {
        contentLines.push(...workerLines);
        contentLines.push(sectionSeparator);
      }

      contentLines.push(...mainLines);

      if (feedLines.length > 0) {
        contentLines.push(sectionSeparator);
        contentLines.push(...feedLines);
      }

      if (contentLines.length > contentHeight) {
        contentLines = contentLines.slice(0, contentHeight);
      }
      while (contentLines.length < contentHeight) {
        contentLines.push("");
      }
    }

    for (const line of contentLines) {
      lines.push(row(line));
    }

    lines.push(border("├" + "─".repeat(innerW) + "┤"));
    for (const legendLine of legendLines) {
      lines.push(row(legendLine));
    }
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    if (allEvents.length > 0) {
      this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
    }

    return lines;
  }

  private static readonly SIGNIFICANT_EVENTS = new Set<FeedEventType>([
    "task.done", "task.block", "task.start", "message",
    "task.reset", "task.unblock",
  ]);

  private detectAndFlashEvents(events: FeedEvent[], prevTs: string | null): void {
    if (prevTs === null) return;
    const newEvents = events.filter(e => e.ts > prevTs);
    if (newEvents.length === 0) return;

    const significant = newEvents.filter(e => MessengerOverlay.SIGNIFICANT_EVENTS.has(e.type));
    if (significant.length === 0) return;

    const last = significant[significant.length - 1];
    const sameType = significant.filter(e => e.type === last.type);

    let message: string;
    if (sameType.length > 1) {
      const label =
        last.type === "task.done" ? `${sameType.length} tasks completed` :
        last.type === "task.start" ? `${sameType.length} tasks claimed` :
        last.type === "task.block" ? `${sameType.length} tasks blocked` :
        last.type === "message" ? `${sameType.length} new messages` :
        `${sameType.length} ${last.type} events`;
      message = label;
    } else {
      const target = last.target ? ` ${last.target}` : "";
      const preview = last.preview ? ` — ${last.preview.slice(0, 40)}` : "";
      message =
        last.type === "task.done" ? `${last.agent} completed${target}` :
        last.type === "task.start" ? `${last.agent} claimed${target}` :
        last.type === "task.block" ? `${last.agent} blocked${target}${preview}` :
        last.type === "message" ? `${last.agent}${preview || " sent a message"}` :
        `${last.agent} ${last.type}${target}`;
    }

    setNotification(this.viewState, this.tui, true, message);
  }

  private checkCompletion(tasks: Task[]): void {
    const allDone = tasks.length > 0 && tasks.every(t => t.status === "done");
    const isIdle = !hasLiveWorkers(this.cwd);

    if (!allDone) {
      this.sawIncompleteWork = true;
      this.cancelCompletionTimer();
      this.completionDismissed = false;
      return;
    }

    if (isIdle && this.sawIncompleteWork && !this.completionTimer && !this.completionDismissed) {
      setNotification(this.viewState, this.tui, true, "All tasks complete! Closing in 3s...");
      this.completionTimer = setTimeout(() => {
        this.completionTimer = null;
        this.done(this.generateSnapshot());
      }, 3000);
    }
  }

  private cancelCompletionTimer(): void {
    if (this.completionTimer) {
      clearTimeout(this.completionTimer);
      this.completionTimer = null;
      this.completionDismissed = true;
    }
  }

  private renderTitleContent(): string {
    return this.theme.fg("accent", "Swarm Messenger");
  }

  invalidate(): void {
    // No cached state
  }

  dispose(): void {
    this.stopProgressRefresh();
    this.cancelCompletionTimer();
    if (this.viewState.notificationTimer) {
      clearTimeout(this.viewState.notificationTimer);
      this.viewState.notificationTimer = null;
    }
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = null;
  }
}
