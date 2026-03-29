import type { Theme } from '@mariozechner/pi-coding-agent';
import type { FeedEvent } from '../feed.js';
import { getFeedLineCount, readFeedEventsByRange } from '../feed.js';
import { calculateRenderedLines, jumpToBottom, maintainScrollOnNewEvents } from '../feed-scroll.js';
import type { MessengerViewState } from '../overlay-actions.js';
import { renderWorkersSection } from '../overlay-render.js';
import { getLiveWorkers } from '../swarm/live-progress.js';

const FEED_LINE_COUNT_CACHE_TTL_MS = 100;
const FEED_WINDOW_SIZE = 200;
const INPUT_CHROME_LINES = 8;

export interface FeedLineCountCache {
  channelId: string;
  expiresAt: number;
  totalLines: number;
}

export function getFeedLineCountCached(
  cwd: string,
  channelId: string,
  cache: FeedLineCountCache | null
): { totalLines: number; cache: FeedLineCountCache } {
  const now = Date.now();
  if (cache && cache.channelId === channelId && cache.expiresAt > now) {
    return { totalLines: cache.totalLines, cache };
  }

  const totalLines = getFeedLineCount(cwd, channelId);
  return {
    totalLines,
    cache: {
      channelId,
      expiresAt: now + FEED_LINE_COUNT_CACHE_TTL_MS,
      totalLines,
    },
  };
}

export function calculateBasePanelHeights(
  mainView: MessengerViewState['mainView'],
  available: number,
  taskCount: number,
  hasWorkers: boolean,
  totalFeedLines: number
): { feedHeight: number; mainHeight: number } {
  let feedHeight: number;
  let mainHeight: number;

  if (mainView === 'tasks' && taskCount === 0) {
    const hasFeed = totalFeedLines > 0;
    if (hasFeed) {
      mainHeight = Math.min(Math.max(2, available - 1), 4);
      feedHeight = Math.max(2, available - mainHeight - 1);
    } else {
      mainHeight = Math.min(10, Math.max(5, available));
      feedHeight = 0;
    }
  } else if (hasWorkers) {
    feedHeight = Math.max(6, Math.floor(available * 0.65));
    mainHeight = available - feedHeight - 1;
  } else {
    feedHeight = Math.max(4, Math.floor(available * 0.55));
    mainHeight = available - feedHeight - 1;
  }

  return {
    feedHeight: Math.max(0, feedHeight),
    mainHeight: Math.max(2, mainHeight),
  };
}

export function estimateFeedViewportHeight(options: {
  theme: Theme;
  cwd: string;
  mainView: MessengerViewState['mainView'];
  termRows: number;
  sectionWidth: number;
  taskCount: number;
  totalFeedLines: number;
}): number {
  const { theme, cwd, mainView, termRows, sectionWidth, taskCount, totalFeedLines } = options;
  const workersLimit = termRows <= 26 ? 2 : 5;
  const workerLines = renderWorkersSection(
    theme,
    cwd,
    sectionWidth,
    workersLimit,
    getLiveWorkers(cwd)
  );
  const agentsHeight = 2;
  const workersHeight = workerLines.length > 0 ? workerLines.length + 1 : 0;
  const contentHeight = Math.max(8, termRows - INPUT_CHROME_LINES);
  const available = contentHeight - workersHeight - agentsHeight;
  const { feedHeight } = calculateBasePanelHeights(
    mainView,
    available,
    taskCount,
    workerLines.length > 0,
    totalFeedLines
  );
  return feedHeight;
}

export function ensureFeedWindowInitialized(options: {
  cwd: string;
  viewState: MessengerViewState;
  channelId: string;
  totalFeedLines: number;
}): void {
  const { cwd, viewState, channelId, totalFeedLines } = options;
  if (viewState.feedLoadedEvents.length > 0 || totalFeedLines <= 0) return;

  const startIdx = Math.max(0, totalFeedLines - FEED_WINDOW_SIZE);
  const endIdx = totalFeedLines;
  viewState.feedLoadedEvents = readFeedEventsByRange(cwd, startIdx, endIdx, channelId);
  viewState.feedWindowStart = startIdx;
  viewState.feedWindowEnd = endIdx;
  viewState.feedTotalLines = totalFeedLines;
  viewState.feedLineScrollOffset = 0;
  viewState.wasAtBottom = true;
}

export function getRenderedFeedLineCountFor(options: {
  theme: Theme;
  viewState: MessengerViewState;
  events: FeedEvent[];
  sectionWidth: number;
  lastSeenEventTs?: string | null;
}): number {
  const {
    theme,
    viewState,
    events,
    sectionWidth,
    lastSeenEventTs = viewState.lastSeenEventTs,
  } = options;
  return calculateRenderedLines(
    events,
    theme,
    sectionWidth,
    lastSeenEventTs,
    viewState.expandFeedMessages
  ).lines.length;
}

export function syncFeedWindow(options: {
  cwd: string;
  theme: Theme;
  viewState: MessengerViewState;
  channelId: string;
  sectionWidth: number;
  totalFeedLines: number;
}): void {
  const { cwd, theme, viewState, channelId, sectionWidth, totalFeedLines } = options;
  ensureFeedWindowInitialized({ cwd, viewState, channelId, totalFeedLines });
  if (totalFeedLines <= viewState.feedTotalLines) return;

  const previousLoadedEvents = viewState.feedLoadedEvents;
  const renderLastSeenTs = viewState.lastSeenEventTs;
  const newEvents = readFeedEventsByRange(cwd, viewState.feedTotalLines, totalFeedLines, channelId);
  const previousRenderedLines = getRenderedFeedLineCountFor({
    theme,
    viewState,
    events: previousLoadedEvents,
    sectionWidth,
    lastSeenEventTs: renderLastSeenTs,
  });
  const appendedEvents = [...previousLoadedEvents, ...newEvents];
  const appendedRenderedLines = getRenderedFeedLineCountFor({
    theme,
    viewState,
    events: appendedEvents,
    sectionWidth,
    lastSeenEventTs: renderLastSeenTs,
  });
  const addedRenderedLines = Math.max(0, appendedRenderedLines - previousRenderedLines);

  viewState.feedLoadedEvents = appendedEvents;

  const wasAtBottomBefore = viewState.wasAtBottom;

  if (viewState.feedLoadedEvents.length > FEED_WINDOW_SIZE) {
    const toRemove = viewState.feedLoadedEvents.length - FEED_WINDOW_SIZE;
    viewState.feedLoadedEvents = viewState.feedLoadedEvents.slice(toRemove);
    viewState.feedWindowStart += toRemove;
  }

  viewState.feedWindowEnd = totalFeedLines;
  viewState.feedTotalLines = totalFeedLines;

  if (wasAtBottomBefore) {
    viewState.feedLineScrollOffset = jumpToBottom();
    return;
  }

  if (addedRenderedLines <= 0) return;

  const newRenderedLines = getRenderedFeedLineCountFor({
    theme,
    viewState,
    events: viewState.feedLoadedEvents,
    sectionWidth,
    lastSeenEventTs: renderLastSeenTs,
  });

  viewState.feedLineScrollOffset = maintainScrollOnNewEvents(
    viewState.feedLineScrollOffset,
    false,
    Math.max(0, newRenderedLines - addedRenderedLines),
    newRenderedLines,
    1
  );
}

export function buildRenderCacheKey(
  viewState: MessengerViewState,
  params: {
    width: number;
    termRows: number;
    channelId: string;
    taskCount?: number;
    selectedTaskId?: string;
    selectedSwarmAgentName?: string;
    totalFeedLines?: number;
    prevTs?: string | null;
  }
): string {
  const {
    width,
    termRows,
    channelId,
    taskCount,
    selectedTaskId = '',
    selectedSwarmAgentName = '',
    totalFeedLines,
    prevTs,
  } = params;

  return [
    width,
    termRows,
    channelId,
    viewState.mainView,
    viewState.mode,
    viewState.selectedTaskIndex,
    viewState.selectedSwarmIndex,
    viewState.scrollOffset,
    viewState.swarmScrollOffset,
    viewState.detailScroll,
    viewState.detailAutoScroll ? 1 : 0,
    viewState.inputMode,
    viewState.expandFeedMessages ? 1 : 0,
    viewState.feedLineScrollOffset,
    viewState.feedWindowStart,
    viewState.feedWindowEnd,
    viewState.feedTotalLines,
    viewState.notification?.message ?? '',
    viewState.notification?.expiresAt ?? 0,
    viewState.confirmAction?.type ?? '',
    viewState.confirmAction?.taskId ?? '',
    viewState.blockReasonInput,
    viewState.messageInput,
    totalFeedLines ?? '',
    taskCount ?? '',
    selectedTaskId,
    selectedSwarmAgentName,
    prevTs ?? '',
  ].join('|');
}
