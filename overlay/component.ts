/**
 * Pi Messenger - Swarm Overlay Component
 */

import type { Component, Focusable, TUI } from '@earendil-works/pi-tui';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { MessengerState, Dirs } from '../lib.js';
import { displayChannelLabel, listChannels } from '../channel.js';
import { getEffectiveSessionId } from '../store/shared.js';
import * as taskStore from '../swarm/task-store.js';
import { type FeedEvent } from '../feed/index.js';
import type { SwarmTask as Task } from '../swarm/types.js';
import {
  renderStatusBar,
  renderWorkersSection,
  renderLegend,
  renderDetailView,
  renderSwarmDetail,
} from './render-exports.js';
import { createMessengerViewState, setNotification, type MessengerViewState } from './actions.js';
import { handleOverlayInput } from './input.js';
import { generateSwarmSnapshot } from './snapshot.js';
import {
  buildRenderCacheKey as buildOverlayRenderCacheKey,
  calculateBasePanelHeights as calculateOverlayBasePanelHeights,
  ensureFeedWindowInitialized as initializeOverlayFeedWindow,
  estimateFeedViewportHeight as estimateOverlayFeedViewportHeight,
  getFeedLineCountCached as getCachedFeedLineCount,
  getRenderedFeedLineCountFor as getOverlayRenderedFeedLineCountFor,
  syncFeedWindow as syncOverlayFeedWindow,
  type FeedLineCountCache,
} from './feed-window.js';
import {
  computeCompletionState,
  getSignificantEventMessage,
  type CompletionStateCache,
} from './notifications.js';
import { getLiveWorkers, hasLiveWorkers, onLiveWorkersChanged } from '../swarm/live-progress.js';
import { listSpawnedHistory } from '../swarm/spawn.js';
import { loadConfig } from '../config.js';

import { calculateListLayout } from './render-layout.js';

export interface OverlayCallbacks {
  onBackground?: (snapshot: string) => void;
  onSwitchChannel?: (channelId: string) => boolean;
}

const RENDER_CACHE_TTL_MS = 50;

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
  private discoveredChannelsCache: { channels: string[]; expiresAt: number } | null = null;
  private autoSwitchedToChannel = new Set<string>();
  private lastRenderedChannel: string | null = null;

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

  /**
   * Get the list of all channel IDs on disk, cached with a TTL.
   * Avoids redundant file I/O on every render.
   */
  private getDiscoveredChannelIds(): string[] {
    const now = Date.now();
    if (this.discoveredChannelsCache && this.discoveredChannelsCache.expiresAt > now) {
      return this.discoveredChannelsCache.channels;
    }
    const channels = listChannels(this.dirs).map((c) => c.id);
    this.discoveredChannelsCache = { channels, expiresAt: now + 2000 };
    return channels;
  }

  /**
   * Count channels that exist on disk (e.g. created by subagents)
   * but aren't in the main agent's joinedChannels.
   */
  private getUndiscoveredChannelCount(): number {
    const joinedSet = new Set(this.state.joinedChannels);
    return this.getDiscoveredChannelIds().filter((id) => !joinedSet.has(id)).length;
  }

  /**
   * Build a merged channel list: joined channels first (in order),
   * then any other channels that exist on disk but aren't joined yet.
   * This ensures subagent-created channels are discoverable in the UI.
   */
  private getAllDiscoveredChannels(): string[] {
    const joined =
      this.state.joinedChannels.length > 0
        ? this.state.joinedChannels
        : [this.state.currentChannel];
    const joinedSet = new Set(joined);
    // Discover channels that exist on disk (e.g. created by subagents)
    // but aren't in the main agent's joinedChannels yet.
    const onDisk = this.getDiscoveredChannelIds();
    const all = [...joined];
    for (const ch of onDisk) {
      if (!joinedSet.has(ch)) {
        all.push(ch);
      }
    }
    return all;
  }

  /**
   * Auto-switch to a newly discovered channel (e.g. one created by a subagent).
   * Switches at most once per channel to avoid fighting with the user's
   * manual channel selection.
   */
  private autoSwitchToNewChannel(): void {
    const onDisk = this.getDiscoveredChannelIds();

    // Find channels that exist on disk but aren't joined and haven't been
    // auto-switched to yet. These are likely created by subagents.
    const joinedSet = new Set(this.state.joinedChannels);
    const newChannel = onDisk.find(
      (id) => !joinedSet.has(id) && !this.autoSwitchedToChannel.has(id)
    );

    if (newChannel) {
      this.autoSwitchedToChannel.add(newChannel);
      const switched = this.callbacks.onSwitchChannel?.(newChannel);
      if (switched) {
        setNotification(
          this.viewState,
          this.tui,
          true,
          `Auto-switched to ${displayChannelLabel(newChannel)}`
        );
      }
    }
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
    const allChannels = this.getAllDiscoveredChannels();
    if (allChannels.length <= 1) return;
    const currentIndex = Math.max(0, allChannels.indexOf(this.state.currentChannel));
    const nextIndex = (currentIndex + direction + allChannels.length) % allChannels.length;
    const nextChannel = allChannels[nextIndex];
    const switched = this.callbacks.onSwitchChannel?.(nextChannel);
    if (!switched) return;

    this.feedLineCountCache = null;
    this.discoveredChannelsCache = null;
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
    // Auto-switch to newly discovered channels (e.g. created by subagents).
    // Runs on each render and switches at most once per new channel.
    this.autoSwitchToNewChannel();

    // If the channel changed (e.g. via auto-switch or external state mutation),
    // reset the feed window so it reloads for the new channel.
    const currentCh = this.currentChannel();
    if (this.lastRenderedChannel !== null && this.lastRenderedChannel !== currentCh) {
      this.feedLineCountCache = null;
      this.discoveredChannelsCache = null;
      this.viewState.feedLoadedEvents = [];
      this.viewState.feedWindowStart = 0;
      this.viewState.feedWindowEnd = 0;
      this.viewState.feedTotalLines = 0;
      this.viewState.feedLineScrollOffset = 0;
      this.viewState.lastSeenEventTs = null;
    }
    this.lastRenderedChannel = currentCh;

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
    const spawned = listSpawnedHistory(this.cwd, sessionId);

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
    lines.push(
      row(
        renderStatusBar(
          this.theme,
          this.cwd,
          sectionW,
          channelId,
          liveWorkers,
          tasks,
          sessionId,
          this.getUndiscoveredChannelCount()
        )
      )
    );
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
      const layout = calculateListLayout({
        theme: this.theme,
        cwd: this.cwd,
        sectionW,
        innerW,
        contentHeight,
        termRows,
        state: this.state,
        dirs: this.dirs,
        stuckThresholdMs: this.stuckThresholdMs,
        viewState: this.viewState,
        liveWorkers,
        tasks,
        spawned,
        feedHeight,
        mainHeight,
        totalFeedLines,
        prevTs,
        currentChannel: this.currentChannel(),
        sessionId,
        feedWindowStart: this.viewState.feedWindowStart,
        feedWindowEnd: this.viewState.feedWindowEnd,
      });

      contentLines = layout.contentLines;
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
    const onDisk = this.getDiscoveredChannelIds();
    const joinedSet = new Set(this.state.joinedChannels);
    const isDiscovered =
      !joinedSet.has(this.currentChannel()) && onDisk.includes(this.currentChannel());
    const label = displayChannelLabel(this.currentChannel());
    const suffix = isDiscovered ? ' (unjoined)' : '';
    return this.theme.fg('accent', `Swarm Messenger · ${label}${suffix}`);
  }

  invalidate(): void {
    this.renderCache = null;
    this.discoveredChannelsCache = null;
  }

  dispose(): void {
    this.renderCache = null;
    this.discoveredChannelsCache = null;
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
