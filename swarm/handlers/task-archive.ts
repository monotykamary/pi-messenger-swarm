import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import { summaryLine } from './_utils.js';

export function taskDelete(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.delete', {
      mode: 'task.delete',
      error: 'missing_id',
    });

  const task = taskStore.getTask(cwd, sessionId, params.id);
  if (!task) {
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.delete',
      error: 'not_found',
      id: params.id,
    });
  }

  if (task.status === 'in_progress') {
    return result(`Error: cannot delete ${params.id} while in progress.`, {
      mode: 'task.delete',
      error: 'in_progress',
      id: params.id,
    });
  }

  if (!taskStore.deleteTask(cwd, sessionId, task.id)) {
    return result(`Error: failed to delete ${params.id}.`, {
      mode: 'task.delete',
      error: 'delete_failed',
      id: params.id,
    });
  }

  logFeedEvent(cwd, state.agentName, 'task.delete', task.id, task.title, channelId);

  return result(`Deleted ${task.id}: ${task.title}`, {
    mode: 'task.delete',
    channel: normalizeChannelId(channelId),
    id: task.id,
  });
}

export function taskArchiveDone(
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  const doneTasks = taskStore.getTasks(cwd, sessionId).filter((t) => t.status === 'done');
  if (doneTasks.length === 0) {
    return result('No done tasks to archive.', {
      mode: 'task.archive_done',
      channel: normalizeChannelId(channelId),
      archived: 0,
      archivedIds: [],
    });
  }

  const archivedIds = doneTasks.map((t) => t.id);
  const count = taskStore.archiveDoneTasks(cwd, sessionId);

  logFeedEvent(cwd, state.agentName, 'task.archive', undefined, `${count} done task(s)`, channelId);

  return result(`Archived ${count} done task(s): ${archivedIds.join(', ')}`, {
    mode: 'task.archive_done',
    channel: normalizeChannelId(channelId),
    archived: count,
    archivedIds,
    summary: taskStore.getSummary(cwd, sessionId),
  });
}
