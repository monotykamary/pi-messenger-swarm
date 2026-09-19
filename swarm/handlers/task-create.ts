import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import { summaryLine } from './_utils.js';

export function taskCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.title) {
    return result('Error: title required for task.create', {
      mode: 'task.create',
      error: 'missing_title',
    });
  }

  const dependsOn = params.dependsOn ?? [];
  for (const depId of dependsOn) {
    if (!taskStore.getTask(cwd, sessionId, depId)) {
      return result(`Error: dependency ${depId} not found`, {
        mode: 'task.create',
        error: 'dependency_not_found',
        dependency: depId,
      });
    }
  }

  const task = taskStore.createTask(
    cwd,
    sessionId,
    {
      title: params.title,
      content: params.content,
      dependsOn,
      createdBy: state.agentName,
      channel: channelId,
    },
    channelId
  );

  logFeedEvent(cwd, state.agentName, 'task.start', task.id, `created ${task.title}`, channelId);

  const deps = task.depends_on.length > 0 ? `\nDepends on: ${task.depends_on.join(', ')}` : '';

  return result(
    `✅ Created ${task.id}: ${task.title}${deps}\n\nClaim it:\n  pi-messenger-swarm task claim ${task.id}`,
    {
      mode: 'task.create',
      channel: normalizeChannelId(channelId),
      task,
    }
  );
}
