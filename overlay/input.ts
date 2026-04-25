import { matchesKey, type TUI } from '@mariozechner/pi-tui';
import type { Dirs, MessengerState } from '../lib.js';
import * as taskStore from '../swarm/task-store.js';
import { listSpawned, listSpawnedHistory } from '../swarm/spawn.js';
import type { SwarmTask as Task } from '../swarm/types.js';
import { getFeedLineCount, readFeedEventsByRange } from '../feed.js';
import { getEffectiveSessionId } from '../store/shared.js';
import {
  calculateVisibleRange,
  isAtBottom,
  jumpToBottom,
  jumpToTop,
  scrollDown,
  scrollUp,
} from '../feed/scroll.js';
import {
  handleBlockReasonInput,
  handleConfirmInput,
  handleMessageInput,
  handleTaskKeyBinding,
  type MessengerViewState,
} from './actions.js';
import { navigateSwarm, navigateTask } from '../overlay-render.js';

const FEED_GG_LOAD_SIZE = 100;

function isFeedUpKey(data: string): boolean {
  return data === 'k' || data === 'K';
}

function isFeedDownKey(data: string): boolean {
  return data === 'j' || data === 'J';
}

export interface OverlayInputParams {
  data: string;
  width: number;
  viewState: MessengerViewState;
  cwd: string;
  state: MessengerState;
  dirs: Dirs;
  tui: TUI;
  done: (snapshot?: string) => void;
  onBackground?: (snapshot: string) => void;
  currentChannel: () => string;
  cycleChannel: (direction: 1 | -1) => void;
  generateSnapshot: () => string;
  cancelCompletionTimer: () => void;
  estimateFeedViewportHeight: (
    termRows: number,
    sectionWidth: number,
    taskCount: number,
    totalFeedLines: number
  ) => number;
  ensureFeedWindowInitialized: (channelId: string, totalFeedLines: number) => void;
  getRenderedFeedLineCount: (sectionWidth: number) => number;
}

export function handleOverlayInput({
  data,
  width,
  viewState,
  cwd,
  state,
  dirs,
  tui,
  done,
  onBackground,
  currentChannel,
  cycleChannel,
  generateSnapshot,
  cancelCompletionTimer,
  estimateFeedViewportHeight,
  ensureFeedWindowInitialized,
  getRenderedFeedLineCount,
}: OverlayInputParams): void {
  cancelCompletionTimer();

  if (viewState.pendingG && data !== 'g') {
    viewState.pendingG = false;
  }

  if (viewState.confirmAction) {
    handleConfirmInput(
      data,
      viewState,
      cwd,
      state.agentName,
      currentChannel(),
      getEffectiveSessionId(cwd, state),
      tui
    );
    return;
  }

  if (viewState.inputMode === 'block-reason') {
    const tasks = taskStore.getTasks(cwd, getEffectiveSessionId(cwd, state));
    const task = tasks[viewState.selectedTaskIndex];
    handleBlockReasonInput(
      data,
      viewState,
      cwd,
      task as Task | undefined,
      state.agentName,
      currentChannel(),
      getEffectiveSessionId(cwd, state),
      tui
    );
    return;
  }

  if (viewState.inputMode === 'message') {
    handleMessageInput(data, viewState, state, dirs, cwd, tui);
    return;
  }

  if (data === 'c') {
    cycleChannel(1);
    return;
  }
  if (data === 'C') {
    cycleChannel(-1);
    return;
  }

  if (data === 'e') {
    viewState.expandFeedMessages = !viewState.expandFeedMessages;
    tui.requestRender();
    return;
  }

  if (data === '\x14' || data === 'T' || matchesKey(data, 'shift+t')) {
    done(generateSnapshot());
    return;
  }

  if (data === '\x02' || data === 'B' || matchesKey(data, 'shift+b')) {
    onBackground?.(generateSnapshot());
    return;
  }

  if (matchesKey(data, 'escape') || data === 'q') {
    if (viewState.mode === 'detail') {
      viewState.mode = 'list';
      tui.requestRender();
    } else {
      done();
    }
    return;
  }

  if (data === '@' || matchesKey(data, 'm')) {
    viewState.inputMode = 'message';
    viewState.messageInput = data === '@' ? '@' : '';
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'f')) {
    if (viewState.mode === 'detail') {
      viewState.mode = 'list';
    }
    viewState.mainView = viewState.mainView === 'tasks' ? 'swarm' : 'tasks';
    tui.requestRender();
    return;
  }

  const channelId = currentChannel();
  const totalFeedLines = getFeedLineCount(cwd, channelId);
  const termRows = process.stdout.rows ?? 24;
  const sectionWidth = width - 4;
  const taskList = taskStore.getTasks(cwd, getEffectiveSessionId(cwd, state));
  const feedHeight = estimateFeedViewportHeight(
    termRows,
    sectionWidth,
    taskList.length,
    totalFeedLines
  );

  if (isFeedUpKey(data) || isFeedDownKey(data) || data === 'g' || data === 'G') {
    ensureFeedWindowInitialized(channelId, totalFeedLines);
  }

  if (isFeedUpKey(data)) {
    viewState.pendingG = false;
    const totalRenderedLines = getRenderedFeedLineCount(sectionWidth);
    viewState.feedLineScrollOffset = scrollUp(
      viewState.feedLineScrollOffset,
      totalRenderedLines,
      feedHeight,
      1
    );
    viewState.wasAtBottom = isAtBottom(
      viewState.feedLineScrollOffset,
      totalRenderedLines,
      feedHeight
    );
    tui.requestRender();
    return;
  }
  if (isFeedDownKey(data)) {
    viewState.pendingG = false;
    const totalRenderedLines = getRenderedFeedLineCount(sectionWidth);
    viewState.feedLineScrollOffset = scrollDown(viewState.feedLineScrollOffset, 1);
    viewState.wasAtBottom = isAtBottom(
      viewState.feedLineScrollOffset,
      totalRenderedLines,
      feedHeight
    );
    tui.requestRender();
    return;
  }
  if (data === 'g') {
    if (viewState.pendingG) {
      viewState.pendingG = false;
      viewState.wasAtBottom = false;

      if (viewState.feedWindowStart > 0) {
        const newStart = 0;
        const newEnd = Math.min(FEED_GG_LOAD_SIZE, viewState.feedTotalLines);
        const oldestEvents = readFeedEventsByRange(cwd, newStart, newEnd, channelId);
        viewState.feedLoadedEvents = oldestEvents;
        viewState.feedWindowStart = newStart;
        viewState.feedWindowEnd = newEnd;
      }

      viewState.feedLineScrollOffset = jumpToTop(
        getRenderedFeedLineCount(sectionWidth),
        feedHeight
      );
      tui.requestRender();
      return;
    }
    viewState.pendingG = true;
    return;
  }
  if (data === 'G') {
    viewState.pendingG = false;
    viewState.feedLineScrollOffset = jumpToBottom();
    viewState.wasAtBottom = true;
    tui.requestRender();
    return;
  }
  if (viewState.pendingG) {
    viewState.pendingG = false;
  }

  const tasks = taskStore.getTasks(cwd, getEffectiveSessionId(cwd, state));
  const spawned = listSpawnedHistory(cwd, getEffectiveSessionId(cwd, state));
  const task = tasks[viewState.selectedTaskIndex];
  const swarmAgent = spawned[viewState.selectedSwarmIndex];

  if (matchesKey(data, 'right')) {
    if (viewState.mode === 'detail') {
      if (viewState.mainView === 'swarm') {
        navigateSwarm(viewState, 1, spawned.length);
        viewState.detailAutoScroll = false;
      } else {
        navigateTask(viewState, 1, tasks.length);
        viewState.detailAutoScroll = true;
      }
      viewState.detailScroll = 0;
      tui.requestRender();
    }
    return;
  }

  if (matchesKey(data, 'left')) {
    if (viewState.mode === 'detail') {
      if (viewState.mainView === 'swarm') {
        navigateSwarm(viewState, -1, spawned.length);
        viewState.detailAutoScroll = false;
      } else {
        navigateTask(viewState, -1, tasks.length);
        viewState.detailAutoScroll = true;
      }
      viewState.detailScroll = 0;
      tui.requestRender();
    }
    return;
  }

  if (matchesKey(data, 'up')) {
    if (viewState.mode === 'detail') {
      viewState.detailScroll = Math.max(0, viewState.detailScroll - 1);
      viewState.detailAutoScroll = false;
    } else if (viewState.mainView === 'swarm') {
      navigateSwarm(viewState, -1, spawned.length);
    } else {
      navigateTask(viewState, -1, tasks.length);
    }
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'down')) {
    if (viewState.mode === 'detail') {
      viewState.detailScroll++;
      viewState.detailAutoScroll = false;
    } else if (viewState.mainView === 'swarm') {
      navigateSwarm(viewState, 1, spawned.length);
    } else {
      navigateTask(viewState, 1, tasks.length);
    }
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'home')) {
    if (viewState.mainView === 'swarm') {
      viewState.selectedSwarmIndex = 0;
      viewState.swarmScrollOffset = 0;
    } else {
      viewState.selectedTaskIndex = 0;
      viewState.scrollOffset = 0;
    }
    if (viewState.mode === 'detail') {
      viewState.detailScroll = 0;
      viewState.detailAutoScroll = false;
    }
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'end')) {
    if (viewState.mainView === 'swarm') {
      viewState.selectedSwarmIndex = Math.max(0, spawned.length - 1);
    } else {
      viewState.selectedTaskIndex = Math.max(0, tasks.length - 1);
    }
    if (viewState.mode === 'detail') {
      viewState.detailScroll = 0;
      viewState.detailAutoScroll = viewState.mainView !== 'swarm';
    }
    tui.requestRender();
    return;
  }

  if (matchesKey(data, 'enter')) {
    if (viewState.mode !== 'detail') {
      if (viewState.mainView === 'swarm' && swarmAgent) {
        viewState.mode = 'detail';
        viewState.detailScroll = 0;
        viewState.detailAutoScroll = false;
        tui.requestRender();
      } else if (viewState.mainView === 'tasks' && task) {
        viewState.mode = 'detail';
        viewState.detailScroll = 0;
        viewState.detailAutoScroll = true;
        tui.requestRender();
      }
    }
    return;
  }

  if (viewState.mode === 'detail') {
    if (matchesKey(data, '[')) {
      if (viewState.mainView === 'swarm') {
        navigateSwarm(viewState, -1, spawned.length);
        viewState.detailAutoScroll = false;
      } else {
        navigateTask(viewState, -1, tasks.length);
        viewState.detailAutoScroll = true;
      }
      viewState.detailScroll = 0;
      tui.requestRender();
      return;
    }
    if (matchesKey(data, ']')) {
      if (viewState.mainView === 'swarm') {
        navigateSwarm(viewState, 1, spawned.length);
        viewState.detailAutoScroll = false;
      } else {
        navigateTask(viewState, 1, tasks.length);
        viewState.detailAutoScroll = true;
      }
      viewState.detailScroll = 0;
      tui.requestRender();
      return;
    }
  }

  if (viewState.mainView === 'tasks' && task) {
    handleTaskKeyBinding(
      data,
      task as Task,
      viewState,
      cwd,
      state.agentName,
      currentChannel(),
      getEffectiveSessionId(cwd, state),
      tui
    );
  }
}
