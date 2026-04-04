import type { MessengerActionParams } from '../action-types.js';
import type { MessengerState } from '../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../channel.js';
import { result } from './result.js';
import { logFeedEvent } from '../feed.js';
import * as store from './store.js';
import { cleanupExitedSpawned, listSpawned, spawnSubagent, stopSpawn } from './spawn.js';
import type { SpawnRequest, SwarmTaskEvidence } from './types.js';
import { formatRoleLabel } from './labels.js';

function summaryLine(cwd: string, channelId: string): string {
  const s = store.getSummary(cwd, channelId);
  return `${s.done}/${s.total} done · ${s.in_progress} in progress · ${s.todo} todo · ${s.blocked} blocked`;
}

export function executeSwarmStatus(cwd: string, channelId: string, sessionId: string) {
  cleanupExitedSpawned(cwd, sessionId);
  const tasks = store.getTasks(cwd, channelId);
  const summary = store.getSummary(cwd, channelId);
  const spawned = listSpawned(cwd, sessionId);
  const channelLabel = displayChannelLabel(channelId);

  if (tasks.length === 0) {
    return result(
      `# Agent Swarm ${channelLabel}\n\nNo tasks yet.\n\nCreate one:\n  pi_messenger({ action: "task.create", title: "...", content: "..." })\n\nSpawn a subagent:\n  pi_messenger({ action: "spawn", role: "Researcher", message: "Investigate ..." })`,
      {
        mode: 'swarm',
        channel: normalizeChannelId(channelId),
        summary,
        tasks: [],
        spawned,
      }
    );
  }

  const lines: string[] = [
    `# Agent Swarm ${channelLabel}`,
    '',
    `Summary: ${summaryLine(cwd, channelId)}`,
    '',
  ];

  if (spawned.length > 0) {
    lines.push('## Spawned Agents');
    for (const agent of spawned.slice(0, 8)) {
      const suffix = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(
        `- ${agent.id} · ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${suffix}`
      );
    }
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
    spawned,
  });
}

export function executeTask(
  op: string,
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string
) {
  switch (op) {
    case 'create':
      return taskCreate(params, state, cwd, channelId);
    case 'list':
      return taskList(cwd, channelId);
    case 'show':
      return taskShow(params, cwd, channelId);
    case 'start':
    case 'claim':
      return taskClaim(params, state, cwd, channelId);
    case 'unclaim':
    case 'stop':
      return taskUnclaim(params, state, cwd, channelId);
    case 'done':
      return taskDone(params, state, cwd, channelId);
    case 'block':
      return taskBlock(params, state, cwd, channelId);
    case 'unblock':
      return taskUnblock(params, state, cwd, channelId);
    case 'ready':
      return taskReady(cwd, channelId);
    case 'progress':
      return taskProgress(params, state, cwd, channelId);
    case 'reset':
      return taskReset(params, state, cwd, channelId);
    case 'delete':
      return taskDelete(params, state, cwd, channelId);
    case 'archive_done':
      return taskArchiveDone(state, cwd, channelId);
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
  channelId: string
) {
  if (!params.title) {
    return result('Error: title required for task.create', {
      mode: 'task.create',
      error: 'missing_title',
    });
  }

  const dependsOn = params.dependsOn ?? [];
  for (const depId of dependsOn) {
    if (!store.getTask(cwd, depId, channelId)) {
      return result(`Error: dependency ${depId} not found`, {
        mode: 'task.create',
        error: 'dependency_not_found',
        dependency: depId,
      });
    }
  }

  const task = store.createTask(
    cwd,
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

function taskList(cwd: string, channelId: string) {
  const tasks = store.getTasks(cwd, channelId);
  if (tasks.length === 0) {
    return result(
      `No tasks yet in ${displayChannelLabel(channelId)}. Create one with task.create.`,
      { mode: 'task.list', channel: normalizeChannelId(channelId), tasks: [] }
    );
  }

  const lines: string[] = [
    `# Swarm Tasks ${displayChannelLabel(channelId)}`,
    '',
    `Summary: ${summaryLine(cwd, channelId)}`,
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

function taskShow(params: MessengerActionParams, cwd: string, channelId: string) {
  if (!params.id)
    return result('Error: id required for task.show', { mode: 'task.show', error: 'missing_id' });

  const task = store.getTask(cwd, params.id, channelId);
  if (!task)
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.show',
      error: 'not_found',
      id: params.id,
    });

  const spec = store.getTaskSpec(cwd, task.id, channelId) ?? '*No spec*';
  const progress = store.getTaskProgress(cwd, task.id, channelId);

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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.claim', { mode: 'task.claim', error: 'missing_id' });

  const claimed = store.claimTask(cwd, params.id, state.agentName, params.reason, channelId);
  if (!claimed) {
    const existing = store.getTask(cwd, params.id, channelId);
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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.unclaim', {
      mode: 'task.unclaim',
      error: 'missing_id',
    });

  const unclaimed = store.unclaimTask(cwd, params.id, state.agentName, channelId);
  if (!unclaimed) {
    const existing = store.getTask(cwd, params.id, channelId);
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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.done', { mode: 'task.done', error: 'missing_id' });

  const summary = params.summary ?? 'Task completed';
  const evidence = params.evidence as SwarmTaskEvidence | undefined;
  const completed = store.completeTask(
    cwd,
    params.id,
    state.agentName,
    summary,
    evidence,
    channelId
  );

  if (!completed) {
    const task = store.getTask(cwd, params.id, channelId);
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
    summary: store.getSummary(cwd, channelId),
  });
}

function taskBlock(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.block', { mode: 'task.block', error: 'missing_id' });
  if (!params.reason)
    return result('Error: reason required for task.block', {
      mode: 'task.block',
      error: 'missing_reason',
    });

  const blocked = store.blockTask(cwd, params.id, state.agentName, params.reason, channelId);
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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.unblock', {
      mode: 'task.unblock',
      error: 'missing_id',
    });

  const task = store.unblockTask(cwd, params.id, channelId);
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

function taskReady(cwd: string, channelId: string) {
  const ready = store.getReadyTasks(cwd, channelId);
  if (ready.length === 0) {
    return result('No ready tasks right now.', {
      mode: 'task.ready',
      channel: normalizeChannelId(channelId),
      ready: [],
      summary: store.getSummary(cwd, channelId),
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
  channelId: string
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

  const task = store.getTask(cwd, params.id, channelId);
  if (!task)
    return result(`Error: task ${params.id} not found`, {
      mode: 'task.progress',
      error: 'not_found',
      id: params.id,
    });

  store.appendTaskProgress(cwd, task.id, state.agentName, params.message, channelId);
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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.reset', { mode: 'task.reset', error: 'missing_id' });

  const cascade = params.cascade === true;
  const reset = store.resetTask(cwd, params.id, cascade, channelId);
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
  channelId: string
) {
  if (!params.id)
    return result('Error: id required for task.delete', {
      mode: 'task.delete',
      error: 'missing_id',
    });

  const task = store.getTask(cwd, params.id, channelId);
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

  if (!store.deleteTask(cwd, task.id, channelId)) {
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

function taskArchiveDone(state: MessengerState, cwd: string, channelId: string) {
  const archived = store.archiveDoneTasks(cwd, channelId);
  if (archived.archived === 0) {
    return result('No done tasks to archive.', {
      mode: 'task.archive_done',
      channel: normalizeChannelId(channelId),
      archived: 0,
      archivedIds: [],
      archiveDir: null,
    });
  }

  logFeedEvent(
    cwd,
    state.agentName,
    'task.archive',
    undefined,
    `${archived.archived} done task(s)`,
    channelId
  );

  return result(
    `Archived ${archived.archived} done task(s): ${archived.archivedIds.join(', ')}\nArchive: ${archived.archiveDir}`,
    {
      mode: 'task.archive_done',
      channel: normalizeChannelId(channelId),
      archived: archived.archived,
      archivedIds: archived.archivedIds,
      archiveDir: archived.archiveDir,
      summary: store.getSummary(cwd, channelId),
    }
  );
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
    const items = listSpawned(cwd, sessionId);
    if (items.length === 0) {
      return result('No spawned agents for this project.', { mode: 'spawn.list', agents: [] });
    }

    const lines = [
      '# Spawned Agents',
      '',
      ...items.map((agent) => {
        const tail = agent.taskId ? ` → ${agent.taskId}` : '';
        return `- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)}) · ${agent.status}${tail}`;
      }),
    ];

    return result(lines.join('\n'), {
      mode: 'spawn.list',
      agents: items,
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
