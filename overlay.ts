/**
 * Pi Messenger - Swarm Overlay Component
 */

import type { Component, Focusable, TUI } from '@mariozechner/pi-tui';
import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import type { MessengerState, Dirs } from './lib.js';
import { displayChannelLabel } from './channel.js';
import { getEffectiveSessionId } from './store/shared.js';
import * as taskStore from './swarm/task-store.js';
import { readFeedEventsByRange, type FeedEvent } from './feed.js';
import type { SwarmTask as Task } from './swarm/types.js';
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
} from './overlay-render.js';
import {
  createMessengerViewState,
  setNotification,
  type MessengerViewState,
} from './overlay-actions.js';
import { handleOverlayInput } from './overlay/input.js';
import { generateSwarmSnapshot } from './overlay/snapshot.js';
import {
  buildRenderCacheKey as buildOverlayRenderCacheKey,
  calculateBasePanelHeights as calculateOverlayBasePanelHeights,
  ensureFeedWindowInitialized as initializeOverlayFeedWindow,
  estimateFeedViewportHeight as estimateOverlayFeedViewportHeight,
  getFeedLineCountCached as getCachedFeedLineCount,
  getRenderedFeedLineCountFor as getOverlayRenderedFeedLineCountFor,
  syncFeedWindow as syncOverlayFeedWindow,
  type FeedLineCountCache,
} from './overlay/feed-window.js';
import {
  computeCompletionState,
  getSignificantEventMessage,
  type CompletionStateCache,
} from './overlay/notifications.js';
import { getLiveWorkers, hasLiveWorkers, onLiveWorkersChanged } from './swarm/live-progress.js';
import { listSpawned } from './swarm/spawn.js';
import { loadConfig } from './config.js';
import { calculateVisibleRange, calculateWindowForOlderLoad } from './feed-scroll.js';

export interface OverlayCallbacks {
  onBackground?: (snapshot: string) => void;
  onSwitchChannel?: (channelId: string) => boolean;
}

const RENDER_CACHE_TTL_MS = 50;
const FEED_WINDOW_SIZE = 200;
const FEED_LOAD_CHUNK = 100;

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
  private completionStateCache: CompletionStateCache | null = null;
  private feedLineCountCache: FeedLineCountCache | null = null;
  private rowCache = new Map<string, string>();
  private rowCacheInnerWidth: number | null = null;
  private rowCacheSectionWidth: number | null = null;
  private chromeCache: {
    key: string;
    titleLine: string;
    emptyLine: string;
    middleBorder: string;
    bottomBorder: string;
  } | null = null;
  private renderCache: {
    key: string;
    quickKey: string;
    expiresAt: number;
    tasks: Task[];
    feedEvents: FeedEvent[];
    lines: string[];
  } | null = null;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: (snapshot?: string) => void,
    private callbacks: OverlayCallbacks
  ) {
    this.cwd = process.cwd();
    const cfg = loadConfig(this.cwd);
    this.stuckThresholdMs = cfg.stuckThreshold * 1000;

    for (const key of this.state.unreadCounts.keys()) {
      this.state.unreadCounts.set(key, 0);
    }

    this.progressUnsubscribe = onLiveWorkersChanged(() => {
      this.renderCache = null;
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

  private getSessionIdForChannel(): string {
    return getEffectiveSessionId(this.cwd, this.state);
  }

  private currentChannel(): string {
    return this.state.currentChannel;
  }

  private getFeedLineCountCached(channelId: string): number {
    const next = getCachedFeedLineCount(this.cwd, channelId, this.feedLineCountCache);
    this.feedLineCountCache = next.cache;
    return next.totalLines;
  }

  private calculateBasePanelHeights(
    available: number,
    taskCount: number,
    hasWorkers: boolean,
    totalFeedLines: number
  ): { feedHeight: number; mainHeight: number } {
    return calculateOverlayBasePanelHeights(
      this.viewState.mainView,
      available,
      taskCount,
      hasWorkers,
      totalFeedLines
    );
  }

  private estimateFeedViewportHeight(
    termRows: number,
    sectionWidth: number,
    taskCount: number,
    totalFeedLines: number
  ): number {
    return estimateOverlayFeedViewportHeight({
      theme: this.theme,
      cwd: this.cwd,
      mainView: this.viewState.mainView,
      termRows,
      sectionWidth,
      taskCount,
      totalFeedLines,
    });
  }

  private ensureFeedWindowInitialized(channelId: string, totalFeedLines: number): void {
    initializeOverlayFeedWindow({
      cwd: this.cwd,
      viewState: this.viewState,
      channelId,
      totalFeedLines,
    });
  }

  private getRenderedFeedLineCountFor(
    events: FeedEvent[],
    sectionWidth: number,
    lastSeenEventTs: string | null = this.viewState.lastSeenEventTs
  ): number {
    return getOverlayRenderedFeedLineCountFor({
      theme: this.theme,
      viewState: this.viewState,
      events,
      sectionWidth,
      lastSeenEventTs,
    });
  }

  private getRenderedFeedLineCount(sectionWidth: number): number {
    return this.getRenderedFeedLineCountFor(this.viewState.feedLoadedEvents, sectionWidth);
  }

  private syncFeedWindow(channelId: string, sectionWidth: number, totalFeedLines: number): void {
    syncOverlayFeedWindow({
      cwd: this.cwd,
      theme: this.theme,
      viewState: this.viewState,
      channelId,
      sectionWidth,
      totalFeedLines,
    });
  }

  private buildRenderCacheKey(params: {
    width: number;
    termRows: number;
    channelId: string;
    taskCount?: number;
    selectedTaskId?: string;
    selectedSwarmAgentName?: string;
    totalFeedLines?: number;
    prevTs?: string | null;
  }): string {
    return buildOverlayRenderCacheKey(this.viewState, params);
  }

  private cycleChannel(direction: 1 | -1): void {
    const channels =
      this.state.joinedChannels.length > 0
        ? this.state.joinedChannels
        : [this.state.currentChannel];
    if (channels.length <= 1) return;
    const currentIndex = Math.max(0, channels.indexOf(this.state.currentChannel));
    const nextIndex = (currentIndex + direction + channels.length) % channels.length;
    const nextChannel = channels[nextIndex];
    const switched = this.callbacks.onSwitchChannel?.(nextChannel);
    if (!switched) return;

    this.feedLineCountCache = null;
    this.viewState.feedLoadedEvents = [];
    this.viewState.feedWindowStart = 0;
    this.viewState.feedWindowEnd = 0;
    this.viewState.feedTotalLines = 0;
    this.viewState.feedLineScrollOffset = 0;
    this.viewState.lastSeenEventTs = null;
    this.viewState.selectedTaskIndex = 0;
    this.viewState.mode = 'list';
    setNotification(
      this.viewState,
      this.tui,
      true,
      `Switched to ${displayChannelLabel(nextChannel)}`
    );
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    handleOverlayInput({
      data,
      width: this.width,
      viewState: this.viewState,
      cwd: this.cwd,
      state: this.state,
      dirs: this.dirs,
      tui: this.tui,
      done: this.done,
      onBackground: this.callbacks.onBackground,
      currentChannel: () => this.currentChannel(),
      cycleChannel: (direction) => this.cycleChannel(direction),
      generateSnapshot: () => this.generateSnapshot(),
      cancelCompletionTimer: () => this.cancelCompletionTimer(),
      estimateFeedViewportHeight: (termRows, sectionWidth, taskCount, totalFeedLines) =>
        this.estimateFeedViewportHeight(termRows, sectionWidth, taskCount, totalFeedLines),
      ensureFeedWindowInitialized: (channelId, totalFeedLines) =>
        this.ensureFeedWindowInitialized(channelId, totalFeedLines),
      getRenderedFeedLineCount: (sectionWidth) => this.getRenderedFeedLineCount(sectionWidth),
    });
  }

  private generateSnapshot(): string {
    return generateSwarmSnapshot(this.cwd, this.currentChannel(), this.state);
  }

  render(_width: number): string[] {
    const w = this.width;
    const innerW = w - 2;
    const sectionW = innerW - 2;
    const border = (s: string) => this.theme.fg('dim', s);
    const pad = (s: string, len: number) => s + ' '.repeat(Math.max(0, len - visibleWidth(s)));
    const sanitizeRowContent = (content: string) =>
      content.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('\t', ' ');
    if (this.rowCacheInnerWidth !== innerW || this.rowCacheSectionWidth !== sectionW) {
      this.rowCache.clear();
      this.rowCacheInnerWidth = innerW;
      this.rowCacheSectionWidth = sectionW;
    }

    const row = (content: string) => {
      const cached = this.rowCache.get(content);
      if (cached) return cached;

      const safe = truncateToWidth(sanitizeRowContent(content), sectionW);
      const rendered = border('│') + pad(' ' + safe, innerW) + border('│');
      if (this.rowCache.size > 2048) this.rowCache.clear();
      this.rowCache.set(content, rendered);
      return rendered;
    };
    const sectionSeparator = this.theme.fg('dim', '─'.repeat(sectionW));

    const channelId = this.currentChannel();
    const termRows = process.stdout.rows ?? 24;
    const initialCachedRender = this.renderCache;
    const ultraEarlyCacheKey = this.buildRenderCacheKey({
      width: w,
      termRows,
      channelId,
      prevTs: this.viewState.lastSeenEventTs,
    });

    if (
      initialCachedRender &&
      initialCachedRender.expiresAt > Date.now() &&
      initialCachedRender.quickKey === ultraEarlyCacheKey &&
      initialCachedRender.feedEvents === this.viewState.feedLoadedEvents
    ) {
      return initialCachedRender.lines;
    }

    const sessionId = this.getSessionIdForChannel();
    const tasks = taskStore.getTasks(this.cwd, sessionId);
    const spawned = listSpawned(this.cwd, sessionId);

    if (tasks.length === 0) {
      this.viewState.selectedTaskIndex = 0;
      if (this.viewState.mainView === 'tasks' && this.viewState.mode === 'detail') {
        this.viewState.mode = 'list';
      }
    } else {
      this.viewState.selectedTaskIndex = Math.max(
        0,
        Math.min(this.viewState.selectedTaskIndex, tasks.length - 1)
      );
    }

    if (spawned.length === 0) {
      this.viewState.selectedSwarmIndex = 0;
      if (this.viewState.mainView === 'swarm' && this.viewState.mode === 'detail') {
        this.viewState.mode = 'list';
      }
    } else {
      this.viewState.selectedSwarmIndex = Math.max(
        0,
        Math.min(this.viewState.selectedSwarmIndex, spawned.length - 1)
      );
    }

    const selectedTask = tasks[this.viewState.selectedTaskIndex] ?? null;
    const selectedSwarmAgent = spawned[this.viewState.selectedSwarmIndex] ?? null;

    if (initialCachedRender) {
      const preFeedSyncCacheKey = this.buildRenderCacheKey({
        width: w,
        termRows,
        channelId,
        totalFeedLines: this.viewState.feedTotalLines,
        taskCount: tasks.length,
        selectedTaskId: selectedTask?.id ?? '',
        selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
        prevTs: this.viewState.lastSeenEventTs,
      });

      if (
        initialCachedRender.expiresAt > Date.now() &&
        initialCachedRender.key === preFeedSyncCacheKey &&
        initialCachedRender.tasks === tasks &&
        initialCachedRender.feedEvents === this.viewState.feedLoadedEvents
      ) {
        return initialCachedRender.lines;
      }
    }

    // Progressive feed loading with sparse sliding window
    const totalFeedLines = this.getFeedLineCountCached(channelId);
    this.syncFeedWindow(channelId, sectionW, totalFeedLines);

    const allEvents = this.viewState.feedLoadedEvents;
    // Initialize lastSeenEventTs on first render so existing events appear dim, not highlighted
    if (this.viewState.lastSeenEventTs === null && allEvents.length > 0) {
      this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
    }
    const prevTs = this.viewState.lastSeenEventTs;
    if (initialCachedRender) {
      const earlyRenderCacheKey = this.buildRenderCacheKey({
        width: w,
        termRows,
        channelId,
        totalFeedLines,
        taskCount: tasks.length,
        selectedTaskId: selectedTask?.id ?? '',
        selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
        prevTs,
      });

      if (
        initialCachedRender.expiresAt > Date.now() &&
        initialCachedRender.key === earlyRenderCacheKey &&
        initialCachedRender.tasks === tasks &&
        initialCachedRender.feedEvents === this.viewState.feedLoadedEvents
      ) {
        return initialCachedRender.lines;
      }
    }

    this.detectAndFlashEvents(allEvents, prevTs);
    this.checkCompletion(tasks);

    const renderCacheKey = this.buildRenderCacheKey({
      width: w,
      termRows,
      channelId,
      totalFeedLines,
      taskCount: tasks.length,
      selectedTaskId: selectedTask?.id ?? '',
      selectedSwarmAgentName: selectedSwarmAgent?.name ?? '',
      prevTs,
    });

    const liveWorkers = getLiveWorkers(this.cwd);

    const lines: string[] = [];
    const titleContent = this.renderTitleContent();
    const chromeKey = `${innerW}|${titleContent}`;
    if (!this.chromeCache || this.chromeCache.key !== chromeKey) {
      const titleText = ` ${titleContent} `;
      const titleLen = visibleWidth(titleContent) + 2;
      const borderLen = Math.max(0, innerW - titleLen);
      const leftBorder = Math.floor(borderLen / 2);
      const rightBorder = borderLen - leftBorder;
      this.chromeCache = {
        key: chromeKey,
        titleLine:
          border('╭' + '─'.repeat(leftBorder)) + titleText + border('─'.repeat(rightBorder) + '╮'),
        emptyLine: border('│') + ' '.repeat(innerW) + border('│'),
        middleBorder: border('├' + '─'.repeat(innerW) + '┤'),
        bottomBorder: border('╰' + '─'.repeat(innerW) + '╯'),
      };
    }

    lines.push(this.chromeCache.titleLine);
    lines.push(row(renderStatusBar(this.theme, this.cwd, sectionW, channelId, liveWorkers, tasks)));
    lines.push(this.chromeCache.emptyLine);

    // Calculate legend first to determine dynamic chrome lines
    const legendLines = renderLegend(
      this.theme,
      this.cwd,
      sectionW,
      this.viewState,
      selectedTask as Task | null,
      selectedSwarmAgent,
      channelId
    );
    const chromeLines = 5 + legendLines.length; // title + status + empty row + separator + bottom border + legend lines
    const contentHeight = Math.max(8, termRows - chromeLines);

    // Calculate feed height consistently (must match the calculation in list mode below)
    const workersLimit = termRows <= 26 ? 2 : 5;
    let workerLines = renderWorkersSection(
      this.theme,
      this.cwd,
      sectionW,
      workersLimit,
      liveWorkers
    );
    const agentsHeight = 2;
    const workersHeight = () => (workerLines.length > 0 ? workerLines.length + 1 : 0);
    const available = contentHeight - workersHeight() - agentsHeight;

    let { feedHeight, mainHeight } = this.calculateBasePanelHeights(
      available,
      tasks.length,
      workerLines.length > 0,
      totalFeedLines
    );

    let contentLines: string[];
    if (this.viewState.mode === 'detail') {
      if (this.viewState.mainView === 'swarm' && selectedSwarmAgent) {
        contentLines = renderSwarmDetail(
          selectedSwarmAgent,
          sectionW,
          contentHeight,
          this.viewState
        );
      } else if (this.viewState.mainView === 'tasks' && selectedTask) {
        contentLines = renderDetailView(
          this.cwd,
          selectedTask as Task,
          sectionW,
          contentHeight,
          this.viewState,
          channelId,
          this.getSessionIdForChannel(),
          liveWorkers
        );
      } else {
        contentLines = [];
        while (contentLines.length < contentHeight) contentLines.push('');
      }
    } else {
      const agentsLine = renderAgentsRow(
        this.cwd,
        sectionW,
        this.state,
        this.dirs,
        this.stuckThresholdMs,
        liveWorkers
      );

      // Adjust heights based on list panel content (may increase feedHeight)
      const isListPanel = this.viewState.mainView === 'swarm' || tasks.length > 0;
      if (isListPanel) {
        const listContentHeight =
          this.viewState.mainView === 'swarm'
            ? Math.max(2, spawned.length)
            : Math.max(2, tasks.length);
        if (listContentHeight < mainHeight) {
          const surplus = mainHeight - listContentHeight;
          feedHeight += surplus;
          mainHeight = listContentHeight;
        }
      }

      const calculateFeedLinesForHeight = (viewportHeight: number): string[] => {
        if (viewportHeight <= 0) return [];

        let rangeResult = calculateVisibleRange(
          this.viewState.feedLoadedEvents,
          this.theme,
          sectionW,
          prevTs,
          this.viewState.expandFeedMessages,
          this.viewState.feedLineScrollOffset,
          viewportHeight,
          this.viewState.feedWindowStart,
          totalFeedLines
        );

        this.viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
        this.viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;

        if (rangeResult.needsOlderLoad && this.viewState.feedWindowStart > 0) {
          const { newWindowStart, newWindowEnd } = calculateWindowForOlderLoad(
            this.viewState.feedWindowStart,
            this.viewState.feedWindowEnd,
            FEED_LOAD_CHUNK,
            FEED_WINDOW_SIZE,
            totalFeedLines
          );

          const olderEvents = readFeedEventsByRange(
            this.cwd,
            newWindowStart,
            this.viewState.feedWindowStart,
            this.currentChannel()
          );
          if (olderEvents.length > 0) {
            this.viewState.feedLoadedEvents = [...olderEvents, ...this.viewState.feedLoadedEvents];
            this.viewState.feedWindowStart = newWindowStart;
            this.viewState.feedWindowEnd = newWindowEnd;

            rangeResult = calculateVisibleRange(
              this.viewState.feedLoadedEvents,
              this.theme,
              sectionW,
              prevTs,
              this.viewState.expandFeedMessages,
              this.viewState.feedLineScrollOffset,
              viewportHeight,
              this.viewState.feedWindowStart,
              totalFeedLines
            );
            this.viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
            this.viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;
          }
        }

        return rangeResult.visibleLines;
      };

      let mainLines: string[];
      if (this.viewState.mainView === 'swarm') {
        mainLines = renderSwarmList(this.theme, spawned, sectionW, mainHeight, this.viewState);
      } else if (tasks.length === 0) {
        mainLines = renderEmptyState(
          this.theme,
          this.cwd,
          sectionW,
          mainHeight,
          this.currentChannel()
        );
      } else {
        mainLines = renderTaskList(
          this.theme,
          this.cwd,
          sectionW,
          mainHeight,
          this.viewState,
          channelId,
          liveWorkers,
          tasks
        );
      }

      let feedLines = calculateFeedLinesForHeight(feedHeight);

      while (
        workerLines.length > 0 &&
        workersHeight() +
          mainLines.length +
          (feedLines.length > 0 ? feedLines.length + 1 : 0) +
          agentsHeight >
          contentHeight
      ) {
        workerLines = workerLines.slice(0, workerLines.length - 1);
      }

      const maxFeedHeight =
        totalFeedLines > 0
          ? Math.max(0, contentHeight - agentsHeight - workersHeight() - mainLines.length - 1)
          : 0;
      if (maxFeedHeight > feedLines.length) {
        feedLines = calculateFeedLinesForHeight(maxFeedHeight);
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
        contentLines.push('');
      }
    }

    for (const line of contentLines) {
      lines.push(row(line));
    }

    lines.push(this.chromeCache.middleBorder);
    for (const legendLine of legendLines) {
      lines.push(row(legendLine));
    }
    lines.push(this.chromeCache.bottomBorder);

    if (allEvents.length > 0) {
      this.viewState.lastSeenEventTs = allEvents[allEvents.length - 1].ts;
    }

    this.renderCache = {
      key: renderCacheKey,
      quickKey: ultraEarlyCacheKey,
      expiresAt: Date.now() + RENDER_CACHE_TTL_MS,
      tasks,
      feedEvents: this.viewState.feedLoadedEvents,
      lines,
    };

    return lines;
  }

  private detectAndFlashEvents(events: FeedEvent[], prevTs: string | null): void {
    const message = getSignificantEventMessage(events, prevTs);
    if (!message) return;
    setNotification(this.viewState, this.tui, true, message);
  }

  private checkCompletion(tasks: Task[]): void {
    this.completionStateCache = computeCompletionState(tasks, this.completionStateCache);
    const allDone = this.completionStateCache.allDone;
    const isIdle = !hasLiveWorkers(this.cwd);

    if (!allDone) {
      this.sawIncompleteWork = true;
      this.cancelCompletionTimer();
      this.completionDismissed = false;
      return;
    }

    if (isIdle && this.sawIncompleteWork && !this.completionTimer && !this.completionDismissed) {
      setNotification(this.viewState, this.tui, true, 'All tasks complete! Closing in 3s...');
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
    return this.theme.fg(
      'accent',
      `Swarm Messenger · ${displayChannelLabel(this.currentChannel())}`
    );
  }

  invalidate(): void {
    this.renderCache = null;
  }

  dispose(): void {
    this.renderCache = null;
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
