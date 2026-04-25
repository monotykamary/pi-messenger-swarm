import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import type { SwarmTaskEvidence } from '../types.js';
import { summaryLine } from './_utils.js';

export function taskClaim(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.claim', { mode: 'task.claim', error: 'missing_id' });

  const claimed = taskStore.claimTask(cwd, sessionId, params.id, state.agentName, params.reason);
  if (!claimed) {
    const existing = taskStore.getTask(cwd, sessionId, params.id);
    if (!existing)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.claim',
        error: 'not_found',
        id: params.id,
      });
    if (existing.status === 'in_progress') {
      return result(
        `Error: ${params.id} is already claimed by ${existing.claimed_by ?? 'another agent'}.`,
        {
          mode: 'task.claim',
          error: 'already_claimed',
          id: params.id,
          claimedBy: existing.claimed_by,
        }
      );
    }
    if (existing.status === 'done') {
      return result(`Error: ${params.id} is already completed.`, {
        mode: 'task.claim',
        error: 'already_done',
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is not ready to claim (check dependencies).`, {
      mode: 'task.claim',
      error: 'not_ready',
      id: params.id,
    });
  }

  logFeedEvent(cwd, state.agentName, 'task.start', claimed.id, claimed.title, channelId);

  return result(`🔄 Claimed ${claimed.id}: ${claimed.title}`, {
    mode: 'task.claim',
    channel: normalizeChannelId(channelId),
    task: claimed,
  });
}

export function taskUnclaim(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.unclaim', {
      mode: 'task.unclaim',
      error: 'missing_id',
    });

  const unclaimed = taskStore.unclaimTask(cwd, sessionId, params.id, state.agentName);
  if (!unclaimed) {
    const existing = taskStore.getTask(cwd, sessionId, params.id);
    if (!existing)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.unclaim',
        error: 'not_found',
        id: params.id,
      });
    return result(`Error: ${params.id} cannot be unclaimed by ${state.agentName}.`, {
      mode: 'task.unclaim',
      error: 'not_owner',
      id: params.id,
      claimedBy: existing.claimed_by,
    });
  }

  logFeedEvent(cwd, state.agentName, 'task.reset', unclaimed.id, 'unclaimed', channelId);

  return result(`Released claim on ${unclaimed.id}.`, {
    mode: 'task.unclaim',
    channel: normalizeChannelId(channelId),
    task: unclaimed,
  });
}

export function taskDone(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.done', { mode: 'task.done', error: 'missing_id' });

  const summary = params.summary ?? 'Task completed';
  const evidence = params.evidence as SwarmTaskEvidence | undefined;
  const completed = taskStore.completeTask(
    cwd,
    sessionId,
    params.id,
    state.agentName,
    summary,
    evidence
  );

  if (!completed) {
    const task = taskStore.getTask(cwd, sessionId, params.id);
    if (!task)
      return result(`Error: task ${params.id} not found`, {
        mode: 'task.done',
        error: 'not_found',
        id: params.id,
      });
    if (task.status !== 'in_progress') {
      return result(`Error: ${params.id} is ${task.status}, not in_progress.`, {
        mode: 'task.done',
        error: 'invalid_status',
        id: params.id,
      });
    }
    return result(`Error: ${params.id} is claimed by ${task.claimed_by ?? 'another agent'}.`, {
      mode: 'task.done',
      error: 'not_owner',
      id: params.id,
      claimedBy: task.claimed_by,
    });
  }

  logFeedEvent(cwd, state.agentName, 'task.done', completed.id, summary, channelId);

  return result(`✅ Completed ${completed.id}: ${completed.title}\n\nSummary: ${summary}`, {
    mode: 'task.done',
    channel: normalizeChannelId(channelId),
    task: completed,
    summary: taskStore.getSummary(cwd, sessionId),
  });
}

export function taskReset(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.reset', { mode: 'task.reset', error: 'missing_id' });

  const cascade = params.cascade === true;
  const reset = taskStore.resetTask(cwd, sessionId, params.id, cascade);
  if (reset.length === 0) {
    return result(`Error: failed to reset ${params.id}.`, {
      mode: 'task.reset',
      error: 'reset_failed',
      id: params.id,
    });
  }

  logFeedEvent(
    cwd,
    state.agentName,
    'task.reset',
    params.id,
    cascade ? `cascade (${reset.length})` : 'reset',
    channelId
  );

  return result(`🔄 Reset ${reset.length} task(s): ${reset.map((task) => task.id).join(', ')}`, {
    mode: 'task.reset',
    channel: normalizeChannelId(channelId),
    reset: reset.map((task) => task.id),
    cascade,
  });
}
