import type { MessengerActionParams } from '../../action-types.js';
import type { MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import { logFeedEvent } from '../../feed/index.js';
import * as taskStore from '../task-store.js';
import {
  cleanupExitedSpawned,
  listSpawned,
  listSpawnedHistory,
  spawnSubagent,
  stopSpawn,
} from '../spawn.js';
import type { SpawnRequest } from '../types.js';
import { formatRoleLabel } from '../labels.js';

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
    return spawnList(cwd, sessionId);
  }

  if (op === 'history') {
    return spawnHistory(cwd, sessionId);
  }

  if (op === 'stop') {
    return spawnStop(params, cwd);
  }

  return result(`Unknown spawn operation: ${op}`, {
    mode: 'spawn',
    error: 'unknown_operation',
    operation: op,
  });
}

function spawnList(cwd: string, sessionId: string) {
  const items = listSpawned(cwd, sessionId);
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
    `Use pi-messenger-swarm spawn history to see all agents including completed.`,
  ];

  return result(lines.join('\n'), {
    mode: 'spawn.list',
    agents: items,
  });
}

function spawnHistory(cwd: string, sessionId: string) {
  const items = listSpawnedHistory(cwd, sessionId);
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
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
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
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
      const tail = agent.taskId ? ` → ${agent.taskId}` : '';
      lines.push(`- ${agent.id}: ${agent.name} (${formatRoleLabel(agent.role)})${tail}${ended}`);
    }
    lines.push('');
  }

  if (stopped.length > 0) {
    lines.push(`## Stopped (${stopped.length})`);
    for (const agent of stopped.slice(0, 5)) {
      const ended = agent.endedAt ? ` · ended ${new Date(agent.endedAt).toLocaleTimeString()}` : '';
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

function spawnStop(params: { id?: string }, cwd: string) {
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

function spawnCreate(
  params: MessengerActionParams,
  state: MessengerState,
  cwd: string,
  sessionId: string
) {
  const message = params.message?.trim() || params.prompt?.trim();

  // File-based spawn mode
  if (params.agentFile) {
    const request: SpawnRequest = {
      agentFile: params.agentFile,
      objective: params.objective,
      message,
      context: params.context,
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
  const objective = params.objective?.trim() || message;
  if (!objective) {
    return result('Error: spawn requires mission text or --objective.', {
      mode: 'spawn',
      error: 'missing_objective',
    });
  }

  const role = params.role?.trim() || params.title?.trim() || 'Subagent';
  const request: SpawnRequest = {
    role,
    persona: params.persona,
    objective,
    context: params.context,
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
