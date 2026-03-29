import { formatDuration, type MessengerState } from '../lib.js';
import { readFeedEvents, type FeedEvent } from '../feed.js';
import * as swarmStore from '../swarm/store.js';
import type { SwarmTask as Task } from '../swarm/types.js';
import { getLiveWorkers } from '../swarm/live-progress.js';

function snapshotIdleLabel(state: MessengerState): string {
  const last = state.activity.lastActivityAt || state.sessionStartedAt;
  const ageMs = Math.max(0, Date.now() - new Date(last).getTime());
  return `idle ${formatDuration(ageMs)}`;
}

function formatTaskSnapshotLine(task: Task, liveTaskIds: Set<string>): string {
  if (task.status === 'done') {
    return `${task.id} (${task.title})`;
  }
  if (task.status === 'in_progress') {
    const parts = [task.title];
    if (task.claimed_by) parts.push(task.claimed_by);
    if (liveTaskIds.has(task.id)) parts.push('live');
    return `${task.id} (${parts.join(', ')})`;
  }
  if (task.status === 'blocked') {
    const reason = task.blocked_reason ? ` — ${task.blocked_reason}` : '';
    return `${task.id} (${task.title}${reason})`;
  }
  if (task.depends_on.length > 0) {
    return `${task.id} (${task.title}, deps: ${task.depends_on.join(' ')})`;
  }
  return `${task.id} (${task.title})`;
}

function formatRecentFeedEvent(event: FeedEvent): string {
  const time = new Date(event.ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  if (event.type === 'task.done')
    return `${event.agent} completed ${event.target ?? 'task'} (${time})`;
  if (event.type === 'task.start')
    return `${event.agent} started ${event.target ?? 'task'} (${time})`;
  if (event.type === 'message') {
    const dir = event.target ? `→ ${event.target}: ` : '✦ ';
    return event.preview
      ? `${event.agent} ${dir}${event.preview} (${time})`
      : `${event.agent} ${dir.trim()} (${time})`;
  }
  if (event.target) return `${event.agent} ${event.type} ${event.target} (${time})`;
  return `${event.agent} ${event.type} (${time})`;
}

export function generateSwarmSnapshot(
  cwd: string,
  channelId: string,
  state: MessengerState
): string {
  const tasks = swarmStore.getTasks(cwd, channelId);
  const liveWorkers = getLiveWorkers(cwd);

  if (tasks.length === 0) {
    return [
      'Swarm snapshot: no tasks',
      '',
      `Agents: You (${snapshotIdleLabel(state)})`,
      '',
      'Create task: pi_messenger({ action: "task.create", title: "..." })',
    ].join('\n');
  }

  const readyTasks = swarmStore.getReadyTasks(cwd, channelId);
  const readyIds = new Set(readyTasks.map((task) => task.id));
  const liveTaskIds = new Set(Array.from(liveWorkers.keys()));
  const activeLines = Array.from(liveWorkers.values()).map((worker) => {
    const activity = worker.progress.currentTool
      ? `${worker.progress.currentTool}${worker.progress.currentToolArgs ? ` ${worker.progress.currentToolArgs}` : ''}`
      : 'thinking';
    return `${worker.taskId} (${worker.name}, ${activity}, ${formatDuration(Date.now() - worker.startedAt)})`;
  });

  const doneTasks = tasks.filter((task) => task.status === 'done');
  const inProgressTasks = tasks.filter((task) => task.status === 'in_progress');
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const waitingTasks = tasks.filter((task) => task.status === 'todo' && !readyIds.has(task.id));
  const recentEvents = readFeedEvents(cwd, 2, channelId);

  const lines = [
    `Swarm snapshot: ${doneTasks.length}/${tasks.length} tasks done, ${readyTasks.length} ready`,
    '',
    `Active: ${activeLines.length > 0 ? activeLines.join(', ') : 'none'}`,
    `Done: ${doneTasks.length > 0 ? doneTasks.map((task) => formatTaskSnapshotLine(task, liveTaskIds)).join(', ') : 'none'}`,
    `In progress: ${inProgressTasks.length > 0 ? inProgressTasks.map((task) => formatTaskSnapshotLine(task, liveTaskIds)).join(', ') : 'none'}`,
    `Ready: ${readyTasks.length > 0 ? readyTasks.map((task) => formatTaskSnapshotLine(task, liveTaskIds)).join(', ') : 'none'}`,
    `Blocked: ${blockedTasks.length > 0 ? blockedTasks.map((task) => formatTaskSnapshotLine(task, liveTaskIds)).join(', ') : 'none'}`,
    `Waiting: ${waitingTasks.length > 0 ? waitingTasks.map((task) => formatTaskSnapshotLine(task, liveTaskIds)).join(', ') : 'none'}`,
  ];

  if (recentEvents.length > 0) {
    lines.push('');
    lines.push(`Recent: ${recentEvents.map((event) => formatRecentFeedEvent(event)).join(', ')}`);
  }

  return lines.join('\n');
}
