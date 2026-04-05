import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { result } from '../result.js';
import * as taskStore from '../task-store.js';
import { cleanupExitedSpawned, listSpawnedHistory } from '../spawn.js';
import { formatRoleLabel } from '../labels.js';
import { summaryLine } from './_utils.js';

export function executeSwarmStatus(cwd: string, channelId: string, sessionId: string) {
  cleanupExitedSpawned(cwd, sessionId);
  const tasks = taskStore.getTasks(cwd, sessionId);
  const summary = taskStore.getSummary(cwd, sessionId);
  const allAgents = listSpawnedHistory(cwd, sessionId);
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
