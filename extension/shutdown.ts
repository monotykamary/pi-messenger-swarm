/**
 * Session shutdown handler — unclaims tasks, logs leave, and cleans up.
 */

import type { MessengerState, Dirs } from '../lib.js';
import * as store from '../store.js';
import { getEffectiveSessionId } from '../store/shared.js';
import * as taskStore from '../swarm/task-store.js';
import { logFeedEvent } from '../feed/index.js';

export interface ShutdownResult {
  unclaimedCount: number;
}

export async function handleSessionShutdown(
  state: MessengerState,
  dirs: Dirs
): Promise<ShutdownResult> {
  const cwd = process.cwd();
  let unclaimedCount = 0;

  if (state.registered) {
    const sessionId = getEffectiveSessionId(cwd, state);
    const { listSpawnedHistory } = await import('../swarm/spawn.js');
    const spawnedAgents = listSpawnedHistory(cwd, sessionId);
    const spawnedNames = new Set(spawnedAgents.map((s) => s.name));

    // Get all tasks for this session
    const allTasks = taskStore.getTasks(cwd, sessionId);

    // Unclaim tasks held by this agent
    const claimedTasks = allTasks.filter(
      (t) => t.status === 'in_progress' && t.claimed_by === state.agentName
    );
    for (const task of claimedTasks) {
      taskStore.unclaimTask(cwd, sessionId, task.id, state.agentName);
      logFeedEvent(
        cwd,
        state.agentName,
        'task.reset',
        task.id,
        'agent left - task unclaimed',
        state.currentChannel
      );
      unclaimedCount++;
    }

    // Unclaim tasks held by spawned agents
    const spawnedClaimedTasks = allTasks.filter(
      (t) => t.status === 'in_progress' && t.claimed_by && spawnedNames.has(t.claimed_by)
    );
    for (const task of spawnedClaimedTasks) {
      taskStore.unclaimTask(cwd, sessionId, task.id, task.claimed_by!);
      logFeedEvent(
        cwd,
        task.claimed_by!,
        'task.reset',
        task.id,
        'parent agent left - task unclaimed',
        state.currentChannel
      );
      unclaimedCount++;
    }

    logFeedEvent(cwd, state.agentName, 'leave', undefined, undefined, state.currentChannel);
  }

  store.unregister(state, dirs);

  return { unclaimedCount };
}
