/**
 * Overlay list-mode layout calculations.
 *
 * Extracted from the MessengerOverlay render() method so the main component
 * stays focused on lifecycle, caching, and assembly.
 */

import type { Theme } from '@mariozechner/pi-coding-agent';
import type { Dirs, MessengerState } from '../lib.js';
import type { SwarmTask as Task, SpawnedAgent } from '../swarm/types.js';
import type { LiveWorkerInfo } from '../swarm/live-progress.js';
import type { MessengerViewState } from './actions.js';
import type { FeedEvent } from '../feed.js';
import {
  renderWorkersSection,
  renderTaskList,
  renderSwarmList,
  renderAgentsRow,
  renderEmptyState,
} from '../overlay-render.js';
import { calculateVisibleRange, calculateWindowForOlderLoad } from '../feed/scroll.js';
import { readFeedEventsByRange } from '../feed.js';

const FEED_LOAD_CHUNK = 100;
const FEED_WINDOW_SIZE = 200;

export interface ListLayoutResult {
  contentLines: string[];
  sectionSeparator: string;
  workerLines: string[];
}

/**
 * Calculate the list-mode content lines, adjusting heights and loading
 * older feed events as needed. Returns the content lines ready for
 * insertion between the chrome header and the legend/footer.
 */
export function calculateListLayout(params: {
  theme: Theme;
  cwd: string;
  sectionW: number;
  innerW: number;
  contentHeight: number;
  termRows: number;
  state: MessengerState;
  dirs: Dirs;
  stuckThresholdMs: number;
  viewState: MessengerViewState;
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo>;
  tasks: Task[];
  spawned: SpawnedAgent[];
  feedHeight: number;
  mainHeight: number;
  totalFeedLines: number;
  prevTs: string | null;
  currentChannel: string;
  sessionId: string;
  feedWindowStart: number;
  feedWindowEnd: number;
}): ListLayoutResult {
  const {
    theme,
    cwd,
    sectionW,
    innerW,
    contentHeight,
    termRows,
    state,
    dirs,
    stuckThresholdMs,
    viewState,
    liveWorkers,
    tasks,
    spawned,
    mainHeight,
    totalFeedLines,
    prevTs,
    currentChannel,
    feedWindowStart,
    feedWindowEnd,
  } = params;

  let { feedHeight } = params;

  const sectionSeparator = theme.fg('dim', '─'.repeat(sectionW));

  const agentsLine = renderAgentsRow(cwd, sectionW, state, dirs, stuckThresholdMs, liveWorkers);

  // Adjust heights based on list panel content (may increase feedHeight)
  const isListPanel = viewState.mainView === 'swarm' || tasks.length > 0;
  if (isListPanel) {
    const listContentHeight =
      viewState.mainView === 'swarm' ? Math.max(2, spawned.length) : Math.max(2, tasks.length);
    if (listContentHeight < mainHeight) {
      const surplus = mainHeight - listContentHeight;
      feedHeight += surplus;
    }
  }

  const adjustedMainHeight = isListPanel
    ? Math.min(
        mainHeight,
        viewState.mainView === 'swarm' ? Math.max(2, spawned.length) : Math.max(2, tasks.length)
      )
    : mainHeight;

  const calculateFeedLinesForHeight = (viewportHeight: number): string[] => {
    if (viewportHeight <= 0) return [];

    let rangeResult = calculateVisibleRange(
      viewState.feedLoadedEvents,
      theme,
      sectionW,
      prevTs,
      viewState.expandFeedMessages,
      viewState.feedLineScrollOffset,
      viewportHeight,
      viewState.feedWindowStart,
      totalFeedLines
    );

    viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
    viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;

    if (rangeResult.needsOlderLoad && viewState.feedWindowStart > 0) {
      const { newWindowStart, newWindowEnd } = calculateWindowForOlderLoad(
        viewState.feedWindowStart,
        viewState.feedWindowEnd,
        FEED_LOAD_CHUNK,
        FEED_WINDOW_SIZE,
        totalFeedLines
      );

      const olderEvents = readFeedEventsByRange(
        cwd,
        newWindowStart,
        viewState.feedWindowStart,
        currentChannel
      );
      if (olderEvents.length > 0) {
        viewState.feedLoadedEvents = [...olderEvents, ...viewState.feedLoadedEvents];
        viewState.feedWindowStart = newWindowStart;
        viewState.feedWindowEnd = newWindowEnd;

        rangeResult = calculateVisibleRange(
          viewState.feedLoadedEvents,
          theme,
          sectionW,
          prevTs,
          viewState.expandFeedMessages,
          viewState.feedLineScrollOffset,
          viewportHeight,
          viewState.feedWindowStart,
          totalFeedLines
        );
        viewState.wasAtBottom = rangeResult.lineScrollOffset === 0;
        viewState.feedLineScrollOffset = rangeResult.lineScrollOffset;
      }
    }

    return rangeResult.visibleLines;
  };

  let mainLines: string[];
  if (viewState.mainView === 'swarm') {
    mainLines = renderSwarmList(theme, spawned, sectionW, adjustedMainHeight, viewState);
  } else if (tasks.length === 0) {
    mainLines = renderEmptyState(theme, cwd, sectionW, adjustedMainHeight, currentChannel);
  } else {
    mainLines = renderTaskList(
      theme,
      cwd,
      sectionW,
      adjustedMainHeight,
      viewState,
      currentChannel,
      liveWorkers,
      tasks
    );
  }

  let feedLines = calculateFeedLinesForHeight(feedHeight);

  // Calculate workers after feed lines to ensure consistency
  const workersLimit = termRows <= 26 ? 2 : 5;
  let workerLines = renderWorkersSection(theme, cwd, sectionW, workersLimit, liveWorkers);
  const agentsHeight = 2;
  const workersHeight = () => (workerLines.length > 0 ? workerLines.length + 1 : 0);

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

  const contentLines: string[] = [];
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
    contentLines.length = contentHeight;
  }
  while (contentLines.length < contentHeight) {
    contentLines.push('');
  }

  return { contentLines, sectionSeparator, workerLines };
}
