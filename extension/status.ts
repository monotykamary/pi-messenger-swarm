import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { Dirs, MessengerState } from '../lib.js';
import { agentHasTask, computeStatus } from '../lib.js';
import type { MessengerConfig } from '../config.js';
import * as store from '../store.js';
import * as swarmStore from '../swarm/store.js';
import { logFeedEvent } from '../feed.js';
import { getLiveWorkers } from '../swarm/live-progress.js';
import { getRunningSpawnCount } from '../swarm/spawn.js';

interface StatusControllerOptions {
  state: MessengerState;
  dirs: Dirs;
  config: MessengerConfig;
  maybeAutoOpenSwarmOverlay?: (ctx: ExtensionContext) => void;
}

export function createStatusController({
  state,
  dirs,
  config,
  maybeAutoOpenSwarmOverlay,
}: StatusControllerOptions) {
  const notifiedStuck = new Set<string>();

  function checkStuckAgents(ctx: ExtensionContext): void {
    if (!config.stuckNotify || !ctx.hasUI || !state.registered) return;

    const thresholdMs = config.stuckThreshold * 1000;
    const peers = store.getActiveAgents(state, dirs);
    const allClaims = store.getClaims(dirs);

    const currentlyStuck = new Set<string>();

    for (const agent of peers) {
      const agentChannel = agent.currentChannel ?? agent.sessionChannel ?? state.currentChannel;
      const hasTask = agentHasTask(
        agent.name,
        allClaims,
        swarmStore.getTasks(agent.cwd, agentChannel)
      );
      const computed = computeStatus(
        agent.activity?.lastActivityAt ?? agent.startedAt,
        hasTask,
        (agent.reservations?.length ?? 0) > 0,
        thresholdMs
      );

      if (computed.status === 'stuck') {
        currentlyStuck.add(agent.name);

        if (!notifiedStuck.has(agent.name)) {
          notifiedStuck.add(agent.name);
          logFeedEvent(
            ctx.cwd ?? process.cwd(),
            agent.name,
            'stuck',
            undefined,
            undefined,
            agentChannel
          );

          const idleStr = computed.idleFor ?? 'unknown';
          const taskInfo = hasTask ? ' with task in progress' : ' with reservation';
          ctx.ui.notify(`⚠️ ${agent.name} appears stuck (idle ${idleStr}${taskInfo})`, 'warning');
        }
      }
    }

    for (const name of notifiedStuck) {
      if (!currentlyStuck.has(name)) {
        notifiedStuck.delete(name);
      }
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI || !state.registered) return;

    checkStuckAgents(ctx);

    const agents = store.getActiveAgents(state, dirs);
    const activeNames = new Set(agents.map((a) => a.name));
    const count = agents.length;
    const theme = ctx.ui.theme;

    for (const name of state.unreadCounts.keys()) {
      if (!activeNames.has(name)) {
        state.unreadCounts.delete(name);
      }
    }
    for (const name of notifiedStuck) {
      if (!activeNames.has(name)) {
        notifiedStuck.delete(name);
      }
    }

    let totalUnread = 0;
    for (const n of state.unreadCounts.values()) totalUnread += n;

    const nameStr = theme.fg('accent', state.agentName);
    const countStr = theme.fg('dim', ` (${count} peer${count === 1 ? '' : 's'})`);
    const unreadStr = totalUnread > 0 ? theme.fg('accent', ` ●${totalUnread}`) : '';

    const cwd = ctx.cwd ?? process.cwd();
    const activityStr = state.activity.currentActivity
      ? theme.fg('dim', ` · ${state.activity.currentActivity}`)
      : '';

    const swarmSummary = swarmStore.getSummary(cwd, state.currentChannel);
    const taskStr =
      swarmSummary.total > 0
        ? theme.fg('accent', ` ☑ ${swarmSummary.done}/${swarmSummary.total} tasks`)
        : '';

    const runningSpawn = getRunningSpawnCount(cwd);
    const runningLive = getLiveWorkers(cwd).size;
    const workerCount = Math.max(runningSpawn, runningLive);
    const spawnStr = workerCount > 0 ? theme.fg('dim', ` 🔨${workerCount}`) : '';

    ctx.ui.setStatus(
      'messenger',
      `msg: ${nameStr}${countStr}${unreadStr}${activityStr}${taskStr}${spawnStr}`
    );

    maybeAutoOpenSwarmOverlay?.(ctx);
  }

  function clearAllUnreadCounts(): void {
    for (const key of state.unreadCounts.keys()) {
      state.unreadCounts.set(key, 0);
    }
  }

  function resetChannelScopedUiState(): void {
    state.chatHistory.clear();
    state.channelPostHistory = [];
    state.unreadCounts.clear();
    state.seenSenders.clear();
    clearAllUnreadCounts();
  }

  return {
    updateStatus,
    clearAllUnreadCounts,
    resetChannelScopedUiState,
  };
}
