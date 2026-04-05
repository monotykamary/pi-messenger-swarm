import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed.js';
import * as taskStore from '../task-store.js';

export function taskBlock(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.block', { mode: 'task.block', error: 'missing_id' });
  if (!params.reason)
    return result('Error: reason required for task.block', {
      mode: 'task.block',
      error: 'missing_reason',
    });

  const blocked = taskStore.blockTask(cwd, sessionId, params.id, state.agentName, params.reason);
  if (!blocked)
    return result(`Error: failed to block ${params.id}.`, {
      mode: 'task.block',
      error: 'block_failed',
      id: params.id,
    });

  logFeedEvent(cwd, state.agentName, 'task.block', blocked.id, params.reason, channelId);

  return result(`🚫 Blocked ${blocked.id}: ${params.reason}`, {
    mode: 'task.block',
    channel: normalizeChannelId(channelId),
    task: blocked,
  });
}

export function taskUnblock(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.unblock', {
      mode: 'task.unblock',
      error: 'missing_id',
    });

  const task = taskStore.unblockTask(cwd, sessionId, params.id);
  if (!task)
    return result(`Error: failed to unblock ${params.id}.`, {
      mode: 'task.unblock',
      error: 'unblock_failed',
      id: params.id,
    });

  logFeedEvent(cwd, state.agentName, 'task.unblock', task.id, task.title, channelId);

  return result(`⬜ Unblocked ${task.id}.`, {
    mode: 'task.unblock',
    channel: normalizeChannelId(channelId),
    task,
  });
}
