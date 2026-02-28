/**
 * Pi Messenger - Swarm Overlay Component
 */

import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  extractFolder,
  formatDuration,
  type MessengerState,
  type Dirs,
} from "./lib.js";
import * as swarmStore from "./swarm/store.js";
import { readFeedEvents, type FeedEvent, type FeedEventType } from "./feed.js";
import type { SwarmTask as Task } from "./swarm/types.js";
import {
  renderStatusBar,
  renderWorkersSection,
  renderTaskList,
  renderTaskSummary,
  renderFeedSection,
  renderAgentsRow,
  renderLegend,
  renderEmptyState,
  renderDetailView,
  navigateTask,
} from "./overlay-render.js";
import {
  createCrewViewState,
  handleConfirmInput,
  handleBlockReasonInput,
  handleMessageInput,
  handleCrewKeyBinding,
  setNotification,
  type CrewViewState,
} from "./overlay-actions.js";
import { getLiveWorkers, hasLiveWorkers, onLiveWorkersChanged } from "./crew/live-progress.js";
import { loadConfig } from "./config.js";

export interface OverlayCallbacks {
  onBackground?: (snapshot: string) => void;
}

export class MessengerOverlay implements Component, Focusable {
  get width(): number {
    return Math.min(100, Math.max(40, process.stdout.columns ?? 90));
  }
  focused = false;

  private crewViewState: CrewViewState = createCrewViewState();
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

    if (this.crewViewState.confirmAction) {
      handleConfirmInput(data, this.crewViewState, this.cwd, this.state.agentName, this.tui);
      return;
    }

    if (this.crewViewState.inputMode === "block-reason") {
      const tasks = swarmStore.getTasks(this.cwd);
      const task = tasks[this.crewViewState.selectedTaskIndex];
      handleBlockReasonInput(data, this.crewViewState, this.cwd, task as Task | undefined, this.state.agentName, this.tui);
      return;
    }

    if (this.crewViewState.inputMode === "message") {
      handleMessageInput(data, this.crewViewState, this.state, this.dirs, this.cwd, this.tui);
      return;
    }

    if (matchesKey(data, "escape")) {
      if (this.crewViewState.mode === "detail") {
        this.crewViewState.mode = "list";
        this.tui.requestRender();
      } else {
        this.done();
      }
      return;
    }

    if (data === "@" || matchesKey(data, "m")) {
      this.crewViewState.inputMode = "message";
      this.crewViewState.messageInput = data === "@" ? "@" : "";
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "f")) {
      this.crewViewState.feedFocus = !this.crewViewState.feedFocus;
      if (!this.crewViewState.feedFocus) {
        this.crewViewState.feedScrollOffset = 0;
      }
      this.tui.requestRender();
      return;
    }

    // Feed scrolling (when focused): PgUp/PgDn by chunk, Up/Down by line.
    if (matchesKey(data, "pageup")) {
      this.crewViewState.feedScrollOffset += 5;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pagedown")) {
      this.crewViewState.feedScrollOffset = Math.max(0, this.crewViewState.feedScrollOffset - 5);
      this.tui.requestRender();
      return;
    }

    const tasks = swarmStore.getTasks(this.cwd);
    const task = tasks[this.crewViewState.selectedTaskIndex];

    if (matchesKey(data, "right")) {
      if (this.crewViewState.mode === "detail") {
        navigateTask(this.crewViewState, 1, tasks.length);
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "left")) {
      if (this.crewViewState.mode === "detail") {
        navigateTask(this.crewViewState, -1, tasks.length);
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.crewViewState.mode === "detail") {
        this.crewViewState.detailScroll = Math.max(0, this.crewViewState.detailScroll - 1);
        this.crewViewState.detailAutoScroll = false;
      } else if (this.crewViewState.feedFocus) {
        this.crewViewState.feedScrollOffset += 1;
      } else {
        navigateTask(this.crewViewState, -1, tasks.length);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.crewViewState.mode === "detail") {
        this.crewViewState.detailScroll++;
        this.crewViewState.detailAutoScroll = false;
      } else if (this.crewViewState.feedFocus) {
        this.crewViewState.feedScrollOffset = Math.max(0, this.crewViewState.feedScrollOffset - 1);
      } else {
        navigateTask(this.crewViewState, 1, tasks.length);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      this.crewViewState.selectedTaskIndex = 0;
      this.crewViewState.scrollOffset = 0;
      if (this.crewViewState.mode === "detail") {
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = false;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      this.crewViewState.selectedTaskIndex = Math.max(0, tasks.length - 1);
      if (this.crewViewState.mode === "detail") {
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (task && this.crewViewState.mode !== "detail") {
        this.crewViewState.mode = "detail";
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
        this.tui.requestRender();
      }
      return;
    }

    if (this.crewViewState.mode === "detail") {
      if (matchesKey(data, "[")) {
        navigateTask(this.crewViewState, -1, tasks.length);
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "]")) {
        navigateTask(this.crewViewState, 1, tasks.length);
        this.crewViewState.detailScroll = 0;
        this.crewViewState.detailAutoScroll = true;
        this.tui.requestRender();
        return;
      }
    }

    if (task) {
      handleCrewKeyBinding(data, task as Task, this.crewViewState, this.cwd, this.state.agentName, this.tui);
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
    if (tasks.length === 0) {
      this.crewViewState.selectedTaskIndex = 0;
      if (this.crewViewState.mode === "detail") this.crewViewState.mode = "list";
    } else {
      this.crewViewState.selectedTaskIndex = Math.max(0, Math.min(this.crewViewState.selectedTaskIndex, tasks.length - 1));
    }

    const selectedTask = tasks[this.crewViewState.selectedTaskIndex] ?? null;

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

    const chromeLines = 6;
    const termRows = process.stdout.rows ?? 24;
    const contentHeight = Math.max(8, termRows - chromeLines);

    const prevTs = this.crewViewState.lastSeenEventTs;
    const allEvents = readFeedEvents(this.cwd, 20);
    this.detectAndFlashEvents(allEvents, prevTs);
    this.checkCompletion(tasks);

    let contentLines: string[];
    if (this.crewViewState.mode === "detail" && selectedTask) {
      contentLines = renderDetailView(this.cwd, selectedTask as Task, sectionW, contentHeight, this.crewViewState);
    } else {
      const workersLimit = termRows <= 26 ? 2 : 5;
      let workerLines = renderWorkersSection(this.theme, this.cwd, sectionW, workersLimit);
      const agentsLine = renderAgentsRow(this.cwd, sectionW, this.state, this.dirs, this.stuckThresholdMs);
      const agentsHeight = 2;
      const workersHeight = () => workerLines.length > 0 ? workerLines.length + 1 : 0;
      const available = contentHeight - workersHeight() - agentsHeight;

      const isFeedFocus = this.crewViewState.feedFocus;
      let feedHeight: number;
      let mainHeight: number;

      if (tasks.length === 0) {
        const hasFeed = allEvents.length > 0;
        if (hasFeed) {
          // Empty swarm + feed view:
          // - normal: compact instructions (4 rows)
          // - feed focus: tiny instructions (2 rows), more chat visible
          mainHeight = isFeedFocus
            ? Math.min(Math.max(2, available - 1), 2)
            : Math.min(Math.max(2, available - 1), 4);
          feedHeight = Math.max(2, available - mainHeight - 1);
        } else {
          mainHeight = Math.min(10, Math.max(5, available));
          feedHeight = 0;
        }
      } else if (isFeedFocus) {
        const summaryLines = 2;
        mainHeight = summaryLines;
        feedHeight = available - summaryLines - 1;
      } else if (workerLines.length > 0) {
        feedHeight = Math.max(6, Math.floor(available * 0.7));
        mainHeight = available - feedHeight - 1;
      } else {
        feedHeight = Math.max(4, Math.floor(available * 0.6));
        mainHeight = available - feedHeight - 1;
      }

      feedHeight = Math.max(0, feedHeight);
      mainHeight = Math.max(2, mainHeight);

      const isTaskList = !isFeedFocus && tasks.length > 0;
      if (isTaskList) {
        const taskContentHeight = Math.max(2, tasks.length);
        if (taskContentHeight < mainHeight) {
          const surplus = mainHeight - taskContentHeight;
          feedHeight += surplus;
          mainHeight = taskContentHeight;
        }
      }

      if (!this.crewViewState.feedFocus) {
        this.crewViewState.feedScrollOffset = 0;
      }
      const maxFeedOffset = Math.max(0, allEvents.length - feedHeight);
      this.crewViewState.feedScrollOffset = Math.max(0, Math.min(this.crewViewState.feedScrollOffset, maxFeedOffset));
      const feedEnd = allEvents.length - this.crewViewState.feedScrollOffset;
      const feedStart = Math.max(0, feedEnd - feedHeight);
      const displayEvents = allEvents.slice(feedStart, feedEnd);
      let feedLines = renderFeedSection(this.theme, displayEvents, sectionW, prevTs);
      if (feedLines.length > feedHeight) feedLines = feedLines.slice(-feedHeight);

      while (workerLines.length > 0 && workersHeight() + mainHeight + (feedLines.length > 0 ? feedLines.length + 1 : 0) + agentsHeight > contentHeight) {
        workerLines = workerLines.slice(0, workerLines.length - 1);
      }

      let mainLines: string[];
      if (tasks.length === 0) {
        mainLines = renderEmptyState(this.theme, this.cwd, sectionW, mainHeight);
      } else if (isFeedFocus) {
        mainLines = renderTaskSummary(this.theme, this.cwd, sectionW, mainHeight);
      } else {
        mainLines = renderTaskList(this.theme, this.cwd, sectionW, mainHeight, this.crewViewState);
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
    lines.push(row(renderLegend(this.theme, this.cwd, sectionW, this.crewViewState, selectedTask as Task | null)));
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    if (allEvents.length > 0) {
      this.crewViewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
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

    setNotification(this.crewViewState, this.tui, true, message);
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
      setNotification(this.crewViewState, this.tui, true, "All tasks complete! Closing in 3s...");
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
    const label = this.theme.fg("accent", "Swarm Messenger");
    const folder = this.theme.fg("dim", extractFolder(this.cwd));
    return `${label} ─ ${folder}`;
  }

  invalidate(): void {
    // No cached state
  }

  dispose(): void {
    this.stopProgressRefresh();
    this.cancelCompletionTimer();
    if (this.crewViewState.notificationTimer) {
      clearTimeout(this.crewViewState.notificationTimer);
      this.crewViewState.notificationTimer = null;
    }
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = null;
  }
}
