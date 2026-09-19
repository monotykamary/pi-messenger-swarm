import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import * as taskStore from '../task-store.js';

export function taskProgress(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.progress', {
      mode: 'task.progress',
      error: 'missing_id',
    });
  if (!params.message)
    return result('Error: message required for task.progress', {
      mode: 'task.progress',
      error: 'missing_message',
    });

  const task = taskStore.getTask(cwd, sessionId, params.id);
  if (!task)
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.progress',
      error: 'not_found',
      id: params.id,
    });

  taskStore.appendTaskProgress(cwd, sessionId, task.id, state.agentName, params.message);
  return result(`Progress logged for ${task.id}.`, {
    mode: 'task.progress',
    channel: normalizeChannelId(channelId),
    id: task.id,
  });
}
