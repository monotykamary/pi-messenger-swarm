import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { result } from '../result.js';
import { taskCreate } from './task-create.js';
import { taskList, taskShow, taskReady } from './task-query.js';
import { taskClaim, taskUnclaim, taskDone, taskReset } from './task-lifecycle.js';
import { taskBlock, taskUnblock } from './task-block.js';
import { taskDelete, taskArchiveDone } from './task-archive.js';
import { taskProgress } from './task-progress.js';

export function executeTask(
  op: string,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  switch (op) {
    case 'create':
      return taskCreate(params, state, cwd, channelId, sessionId);
    case 'list':
      return taskList(cwd, channelId, sessionId);
    case 'show':
      return taskShow(params, cwd, channelId, sessionId);
    case 'start':
    case 'claim':
      return taskClaim(params, state, cwd, channelId, sessionId);
    case 'unclaim':
    case 'stop':
      return taskUnclaim(params, state, cwd, channelId, sessionId);
    case 'done':
      return taskDone(params, state, cwd, channelId, sessionId);
    case 'block':
      return taskBlock(params, state, cwd, channelId, sessionId);
    case 'unblock':
      return taskUnblock(params, state, cwd, channelId, sessionId);
    case 'ready':
      return taskReady(cwd, channelId, sessionId);
    case 'progress':
      return taskProgress(params, state, cwd, channelId, sessionId);
    case 'reset':
      return taskReset(params, state, cwd, channelId, sessionId);
    case 'delete':
      return taskDelete(params, state, cwd, channelId, sessionId);
    case 'archive_done':
      return taskArchiveDone(state, cwd, channelId, sessionId);
    default:
      return result(`Unknown task operation: ${op}`, {
        mode: 'task',
        error: 'unknown_operation',
        operation: op,
      });
  }
}
