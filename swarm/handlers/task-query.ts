import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import * as taskStore from '../task-store.js';
import { summaryLine } from './_utils.js';

export function taskList(cwd: string, channelId: string, sessionId: string) {
  const tasks = taskStore.getTasks(cwd, sessionId);
  if (tasks.length === 0) {
    return result(
      `No tasks yet in ${displayChannelLabel(channelId)}. Create one with task.create.`,
      { mode: 'task.list', channel: normalizeChannelId(channelId), tasks: [] }
    );
  }

  const lines: string[] = [
    `# Swarm Tasks ${displayChannelLabel(channelId)}`,
    '',
    `Summary: ${summaryLine(cwd, sessionId)}`,
    '',
  ];
  for (const task of tasks) {
    const icon =
      task.status === 'done'
        ? '✅'
        : task.status === 'in_progress'
          ? '🔄'
          : task.status === 'blocked'
            ? '🚫'
            : '⬜';
    const owner = task.claimed_by ? ` [${task.claimed_by}]` : '';
    const deps = task.depends_on.length > 0 ? ` → ${task.depends_on.join(', ')}` : '';
    lines.push(`${icon} ${task.id}: ${task.title}${owner}${deps}`);
  }

  return result(lines.join('\n'), {
    mode: 'task.list',
    channel: normalizeChannelId(channelId),
    tasks,
  });
}

export function taskShow(
  params: { id?: string },
  cwd: string,
  channelId: string,
  sessionId: string
) {
  if (!params.id)
    return result('Error: id required for task.show', { mode: 'task.show', error: 'missing_id' });

  const task = taskStore.getTask(cwd, sessionId, params.id);
  if (!task)
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.show',
      error: 'not_found',
      id: params.id,
    });

  const spec = taskStore.getTaskSpec(cwd, sessionId, task.id) ?? '*No spec*';
  const progress = taskStore.getTaskProgress(cwd, sessionId, task.id);

  const lines: string[] = [
    `# ${task.id}: ${task.title}`,
    '',
    `Channel: ${displayChannelLabel(channelId)}`,
    `Status: ${task.status}`,
    task.claimed_by ? `Claimed by: ${task.claimed_by}` : 'Claimed by: (none)',
    task.depends_on.length > 0 ? `Depends on: ${task.depends_on.join(', ')}` : 'Depends on: (none)',
    '',
    '## Spec',
    spec,
  ];

  if (progress) {
    lines.push('', '## Progress', progress.trimEnd());
  }

  return result(lines.join('\n'), {
    mode: 'task.show',
    channel: normalizeChannelId(channelId),
    task,
    hasProgress: !!progress,
  });
}

export function taskReady(cwd: string, channelId: string, sessionId: string) {
  const ready = taskStore.getReadyTasks(cwd, sessionId);
  if (ready.length === 0) {
    return result('No ready tasks right now.', {
      mode: 'task.ready',
      channel: normalizeChannelId(channelId),
      ready: [],
      summary: taskStore.getSummary(cwd, sessionId),
    });
  }

  const lines = [
    `# Ready Tasks ${displayChannelLabel(channelId)}`,
    '',
    ...ready.map((task) => `- ${task.id}: ${task.title}`),
  ];
  return result(lines.join('\n'), {
    mode: 'task.ready',
    channel: normalizeChannelId(channelId),
    ready,
  });
}
