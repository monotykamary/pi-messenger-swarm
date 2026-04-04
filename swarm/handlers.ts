import type { MessengerActionParams } from '../action-types.js';
import type { MessengerState } from '../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../channel.js';
import { result } from './result.js';
import { logFeedEvent } from '../feed.js';
import * as taskStore from './task-store.js';
import {
  cleanupExitedSpawned,
  listSpawned,
  listSpawnedHistory,
  spawnSubagent,
  stopSpawn,
} from './spawn.js';
import type { SpawnRequest, SwarmTaskEvidence } from './types.js';
import { formatRoleLabel } from './labels.js';
import { executeTaskAction } from './task-actions.js';

function summaryLine(cwd: string, sessionId: string): string {
  const s = taskStore.getSummary(cwd, sessionId);
  return `${s.done}/${s.total} done · ${s.in_progress} in progress · ${s.todo} todo · ${s.blocked} blocked`;
}

export function executeSwarmStatus(cwd: string, channelId: string, sessionId: string) {
  cleanupExitedSpawned(cwd, sessionId);
  const tasks = taskStore.getTasks(cwd, sessionId);
  const summary = taskStore.getSummary(cwd, sessionId);
  const allAgents = listSpawnedHistory(cwd, sessionId); // All agents including completed/failed
  const runningAgents = allAgents.filter((a) => a.status === 'running');
  const completedCount = allAgents.filter((a) => a.status === 'completed').length;
  const failedCount = allAgents.filter((a) => a.status === 'failed').length;
  const channelLabel = displayChannelLabel(channelId);

  if (tasks.length === 0 && runningAgents.length === 0) {
    let text = `# Agent Swarm ${channelLabel}\n\nNo tasks yet.`;
    if (completedCount > 0 || failedCount > 0) {
      text += `\n\n${completedCount} completed, ${failedCount} failed agents in history.`;
    }
    text += `\n\nCreate one:\n  pi_messenger({ action: "task.create", title: "...", content: "..." })\n\nSpawn a subagent:\n  pi_messenger({ action: "spawn", role: "Researcher", message: "Investigate ..." })`;
    if (completedCount > 0 || failedCount > 0) {
      text += `\n\nView history:\n  pi_messenger({ action: "spawn.history" })`;
    }
    return result(text, {
      mode: 'swarm',
      channel: normalizeChannelId(channelId),
      summary,
      tasks: [],
      spawned: runningAgents,
    });
  }

  const lines: string[] = [
    `# Agent Swarm ${channelLabel}`,
    '',
    `Summary: ${summaryLine(cwd, sessionId)}`,
    '',
  ];

  if (runningAgents.length > 0) {
    lines.push('## Running Agents');
    for (const agent of runningAgents.slice(0, 8)) {
      const suffix = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(
        `- ${agent.id} · ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${suffix}`
      );
    }
    lines.push('');
  }

  if (completedCount > 0 || failedCount > 0) {
    lines.push(`## Agent History`);
    lines.push(`- ${completedCount} completed · ${failedCount} failed`);
    lines.push(`- View: pi_messenger({ action: "spawn.history" })`);
    lines.push('');
  }

  lines.push('## Tasks');
  for (const task of tasks) {
    const icon =
      task.status === 'done'
        ? '✅'
        : task.status === 'in_progress'
          ? '🔄'
          : task.status === 'blocked'
            ? '🚫'
            : '⬜';
    const owner = task.claimed_by ? ` (${task.claimed_by})` : '';
    const deps = task.depends_on.length > 0 ? ` → deps: ${task.depends_on.join(', ')}` : '';
    lines.push(`${icon} ${task.id}: ${task.title}${owner}${deps}`);
  }

  return result(lines.join('\n'), {
    mode: 'swarm',
    channel: normalizeChannelId(channelId),
    summary,
    tasks,
    spawned: runningAgents,
  });
}

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

function taskCreate(
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
    `✅ Created ${task.id}: ${task.title}${deps}\n\nClaim it:\n  pi_messenger({ action: "task.claim", id: "${task.id}" })`,
    {
      mode: 'task.create',
      channel: normalizeChannelId(channelId),
      task,
    }
  );
}

function taskList(cwd: string, channelId: string, sessionId: string) {
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

function taskShow(
  params: MessengerActionParams,
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

function taskClaim(
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

function taskUnclaim(
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

function taskDone(
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

function taskBlock(
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

function taskUnblock(
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

function taskReady(cwd: string, channelId: string, sessionId: string) {
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

function taskProgress(
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

function taskReset(
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

function taskDelete(
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

function taskArchiveDone(state: MessengerState, cwd: string, channelId: string, sessionId: string) {
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

export function executeSpawn(
  op: string | null,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string
) {
  cleanupExitedSpawned(cwd, sessionId);

  if (!op) {
    return spawnCreate(params, state, cwd, sessionId);
  }

  if (op === 'list') {
    const items = listSpawned(cwd, sessionId); // All agents by default
    if (items.length === 0) {
      return result('No spawned agents for this project.', {
        mode: 'spawn.list',
        agents: [],
      });
    }

    const lines = [
      '# Running Spawned Agents',
      '',
      ...items.map((agent) => {
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        return `- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${tail}`;
      }),
      '',
      `Use pi_messenger({ action: "spawn.history" }) to see all agents including completed.`,
    ];

    return result(lines.join('\n'), {
      mode: 'spawn.list',
      agents: items,
    });
  }

  if (op === 'history') {
    const items = listSpawnedHistory(cwd, sessionId); // All agents including completed
    const running = items.filter((a) => a.status === 'running');
    const completed = items.filter((a) => a.status === 'completed');
    const failed = items.filter((a) => a.status === 'failed');
    const stopped = items.filter((a) => a.status === 'stopped');

    if (items.length === 0) {
      return result('No spawned agents for this project.', { mode: 'spawn.history', agents: [] });
    }

    const lines: string[] = ['# Spawned Agent History', ''];

    if (running.length > 0) {
      lines.push('## Running');
      for (const agent of running.slice(0, 8)) {
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}`);
      }
      lines.push('');
    }

    if (completed.length > 0) {
      lines.push(`## Completed (${completed.length})`);
      for (const agent of completed.slice(0, 10)) {
        const ended = agent.endedAt
          ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}`
          : '';
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
      }
      if (completed.length > 10) {
        lines.push(`... and ${completed.length - 10} more`);
      }
      lines.push('');
    }

    if (failed.length > 0) {
      lines.push(`## Failed (${failed.length})`);
      for (const agent of failed.slice(0, 5)) {
        const ended = agent.endedAt
          ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}`
          : '';
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
      }
      lines.push('');
    }

    if (stopped.length > 0) {
      lines.push(`## Stopped (${stopped.length})`);
      for (const agent of stopped.slice(0, 5)) {
        const ended = agent.endedAt
          ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}`
          : '';
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
      }
      lines.push('');
    }

    return result(lines.join('\n'), {
      mode: 'spawn.history',
      agents: items,
      counts: {
        running: running.length,
        completed: completed.length,
        failed: failed.length,
        stopped: stopped.length,
      },
    });
  }

  if (op === 'stop') {
    const id = params.id;
    if (!id) {
      return result('Error: id required for spawn.stop', {
        mode: 'spawn.stop',
        error: 'missing_id',
      });
    }

    const stopped = stopSpawn(cwd, id);
    if (!stopped) {
      return result(`Error: could not stop spawn ${id}.`, {
        mode: 'spawn.stop',
        error: 'not_found_or_not_running',
        id,
      });
    }

    return result(`Stopping spawned agent ${id}...`, {
      mode: 'spawn.stop',
      id,
    });
  }

  return result(`Unknown spawn operation: ${op}`, {
    mode: 'spawn',
    error: 'unknown_operation',
    operation: op,
  });
}

function spawnCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string
) {
  const message = params.message?.trim() || params.prompt?.trim();

  // File-based spawn mode
  if (params.agentFile) {
    if (!message) {
      return result('Error: spawn requires mission text via message or prompt.', {
        mode: 'spawn',
        error: 'missing_message',
      });
    }

    const request: SpawnRequest = {
      agentFile: params.agentFile,
      message,
      context: params.content,
      taskId: params.taskId,
      name: params.name,
    };

    try {
      const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
      const roleLabel = formatRoleLabel(record.role);
      logFeedEvent(
        cwd,
        state.agentName,
        'message',
        undefined,
        `spawned ${record.name} (${roleLabel})`,
        state.currentChannel
      );

      return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
        mode: 'spawn',
        agent: record,
      });
    } catch (err) {
      return result(`Error: ${err instanceof Error ? err.message : String(err)}`, {
        mode: 'spawn',
        error: 'spawn_failed',
      });
    }
  }

  // Autoregressive spawn mode (traditional)
  const objective = message;
  if (!objective) {
    return result('Error: spawn requires mission text via message or prompt.', {
      mode: 'spawn',
      error: 'missing_objective',
    });
  }

  const role = params.role?.trim() || params.title?.trim() || 'Subagent';
  const request: SpawnRequest = {
    role,
    persona: params.persona,
    objective,
    context: params.content,
    taskId: params.taskId,
    name: params.name,
  };

  const record = spawnSubagent(cwd, request, sessionId, state.currentChannel);
  const roleLabel = formatRoleLabel(record.role);
  logFeedEvent(
    cwd,
    state.agentName,
    'message',
    undefined,
    `spawned ${record.name} (${roleLabel})`,
    state.currentChannel
  );

  return result(`🚀 Spawned ${record.name} (${record.id}) as ${roleLabel}.`, {
    mode: 'spawn',
    agent: record,
  });
}
