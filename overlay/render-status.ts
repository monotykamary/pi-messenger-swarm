import { truncateToWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import { formatDuration } from '../lib.js';
import * as swarmStore from '../swarm/store.js';
import type { SwarmTask as Task, SpawnedAgent } from '../swarm/types.js';
import { formatRoleLabel } from '../swarm/labels.js';
import { getLiveWorkers, type LiveWorkerInfo } from '../swarm/live-progress.js';
import type { MessengerViewState } from '../overlay-actions.js';

const STATUS_ICONS: Record<string, string> = {
  done: '✓',
  in_progress: '●',
  todo: '○',
  blocked: '✗',
};

let statusBarCache: {
  tasks: Task[];
  width: number;
  channelId: string;
  liveCount: number;
  line: string;
} | null = null;

export function renderStatusBar(
  _theme: Theme,
  cwd: string,
  width: number,
  channelId: string = 'general',
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo> = getLiveWorkers(cwd),
  tasks: Task[] = swarmStore.getTasks(cwd, channelId)
): string {
  const liveCount = liveWorkers.size;
  if (
    statusBarCache &&
    statusBarCache.tasks === tasks &&
    statusBarCache.width === width &&
    statusBarCache.channelId === channelId &&
    statusBarCache.liveCount === liveCount
  ) {
    return statusBarCache.line;
  }

  const summary = swarmStore.getSummaryForTasks(tasks);
  const ready = swarmStore.getReadyTasksForTasks(tasks);

  let line: string;
  if (summary.total === 0) {
    line = truncateToWidth(`No swarm tasks │ ⚙ ${liveCount} live`, width);
  } else {
    line = `☑ ${summary.done}/${summary.total} tasks`;
    line += ` │ ready ${ready.length}`;
    line += ` │ in progress ${summary.in_progress}`;
    line += ` │ blocked ${summary.blocked}`;
    line += ` │ ⚙ ${liveCount} live`;
    line = truncateToWidth(line, width);
  }

  statusBarCache = {
    tasks,
    width,
    channelId,
    liveCount,
    line,
  };
  return line;
}

export function renderWorkersSection(
  theme: Theme,
  cwd: string,
  width: number,
  maxLines: number,
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo> = getLiveWorkers(cwd)
): string[] {
  if (maxLines <= 0) return [];

  const workers = Array.from(liveWorkers.values()).slice(0, maxLines);
  if (workers.length === 0) return [];

  const lines: string[] = [];
  for (const info of workers) {
    const activity = info.progress.currentTool
      ? `${info.progress.currentTool}${info.progress.currentToolArgs ? `(${info.progress.currentToolArgs})` : ''}`
      : 'thinking';
    const elapsed = formatDuration(Date.now() - info.startedAt);
    const tokens =
      info.progress.tokens > 1000
        ? `${(info.progress.tokens / 1000).toFixed(0)}k`
        : `${info.progress.tokens}`;
    const line = `⚡ ${info.name} (${info.taskId})  ${activity}  ${theme.fg('dim', `${elapsed}  ${tokens} tok`)}`;
    lines.push(truncateToWidth(line, width));
  }
  return lines;
}

export function renderTaskList(
  theme: Theme,
  cwd: string,
  width: number,
  height: number,
  viewState: MessengerViewState,
  channelId: string = 'general',
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo> = getLiveWorkers(cwd),
  tasks: Task[] = swarmStore.getTasks(cwd, channelId)
): string[] {
  const lines: string[] = [];

  if (tasks.length === 0) {
    lines.push(theme.fg('dim', '(no tasks yet)'));
    while (lines.length < height) lines.push('');
    return lines.slice(0, height);
  }

  viewState.selectedTaskIndex = Math.max(
    0,
    Math.min(viewState.selectedTaskIndex, tasks.length - 1)
  );

  if (tasks.length <= height) {
    viewState.scrollOffset = 0;
    for (let i = 0; i < tasks.length; i++) {
      lines.push(
        renderTaskLine(
          theme,
          tasks[i],
          i === viewState.selectedTaskIndex,
          width,
          liveWorkers.get(tasks[i].id)
        )
      );
    }
    return lines;
  }

  const selectedLine = viewState.selectedTaskIndex;
  if (selectedLine < viewState.scrollOffset) {
    viewState.scrollOffset = selectedLine;
  } else if (selectedLine >= viewState.scrollOffset + height) {
    viewState.scrollOffset = selectedLine - height + 1;
  }

  viewState.scrollOffset = Math.max(0, Math.min(viewState.scrollOffset, tasks.length - height));
  const start = viewState.scrollOffset;
  const end = Math.min(tasks.length, start + height);

  for (let i = start; i < end; i++) {
    lines.push(
      renderTaskLine(
        theme,
        tasks[i],
        i === viewState.selectedTaskIndex,
        width,
        liveWorkers.get(tasks[i].id)
      )
    );
  }

  return lines;
}

export function renderSwarmList(
  theme: Theme,
  agents: SpawnedAgent[],
  width: number,
  height: number,
  viewState: MessengerViewState
): string[] {
  const lines: string[] = [];

  if (agents.length === 0) {
    lines.push(theme.fg('dim', 'No spawned agents in this session.'));
    lines.push(
      theme.fg(
        'dim',
        'spawn: pi_messenger({ action: "spawn", role: "Researcher", message: "..." })'
      )
    );
    while (lines.length < height) lines.push('');
    return lines.slice(0, height);
  }

  viewState.selectedSwarmIndex = Math.max(
    0,
    Math.min(viewState.selectedSwarmIndex, agents.length - 1)
  );

  const statusIcon = (status: SpawnedAgent['status']): string => {
    if (status === 'running') return theme.fg('warning', '●');
    if (status === 'completed') return theme.fg('accent', '✓');
    if (status === 'failed') return theme.fg('error', '✗');
    return theme.fg('dim', '■');
  };

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const select = i === viewState.selectedSwarmIndex ? theme.fg('accent', '▸ ') : '  ';
    const tailParts: string[] = [formatRoleLabel(agent.role), agent.status];
    if (agent.taskId) tailParts.push(`→ ${agent.taskId}`);
    lines.push(
      truncateToWidth(
        `${select}${statusIcon(agent.status)} ${agent.name}  ${theme.fg('dim', tailParts.join(' · '))}`,
        width
      )
    );
  }

  if (lines.length <= height) {
    viewState.swarmScrollOffset = 0;
    return lines;
  }

  const selectedLine = Math.min(viewState.selectedSwarmIndex, lines.length - 1);
  if (selectedLine < viewState.swarmScrollOffset) {
    viewState.swarmScrollOffset = selectedLine;
  } else if (selectedLine >= viewState.swarmScrollOffset + height) {
    viewState.swarmScrollOffset = selectedLine - height + 1;
  }

  viewState.swarmScrollOffset = Math.max(
    0,
    Math.min(viewState.swarmScrollOffset, lines.length - height)
  );
  return lines.slice(viewState.swarmScrollOffset, viewState.swarmScrollOffset + height);
}

interface TaskLineCacheEntry {
  theme: Theme;
  width: number;
  isSelected: boolean;
  liveWorker: LiveWorkerInfo | undefined;
  line: string;
}

const taskLineCache = new WeakMap<Task, TaskLineCacheEntry>();

function renderTaskLine(
  theme: Theme,
  task: Task,
  isSelected: boolean,
  width: number,
  liveWorker?: LiveWorkerInfo
): string {
  const cached = taskLineCache.get(task);
  if (
    cached &&
    cached.theme === theme &&
    cached.width === width &&
    cached.isSelected === isSelected &&
    cached.liveWorker === liveWorker
  ) {
    return cached.line;
  }
  const select = isSelected ? theme.fg('accent', '▸ ') : '  ';
  const icon = STATUS_ICONS[task.status] ?? '?';
  const coloredIcon =
    task.status === 'done'
      ? theme.fg('accent', icon)
      : task.status === 'in_progress'
        ? theme.fg('warning', icon)
        : task.status === 'blocked'
          ? theme.fg('error', icon)
          : theme.fg('dim', icon);

  let suffix = '';
  if (task.status === 'in_progress' && liveWorker) {
    suffix = ` (${liveWorker.name})`;
  } else if (task.status === 'in_progress' && task.claimed_by) {
    suffix = ` (${task.claimed_by})`;
  } else if (task.status === 'todo' && task.depends_on.length > 0) {
    suffix = ` → ${task.depends_on.join(', ')}`;
  } else if (task.status === 'blocked' && task.blocked_reason) {
    const reason = task.blocked_reason.slice(0, 28);
    suffix = ` [${reason}${task.blocked_reason.length > 28 ? '…' : ''}]`;
  }

  const line = truncateToWidth(
    `${select}${coloredIcon} ${task.id}  ${task.title}${theme.fg('dim', suffix)}`,
    width
  );
  taskLineCache.set(task, {
    theme,
    width,
    isSelected,
    liveWorker,
    line,
  });
  return line;
}

export function navigateTask(
  viewState: MessengerViewState,
  direction: 1 | -1,
  taskCount: number
): void {
  if (taskCount === 0) return;
  viewState.selectedTaskIndex = Math.max(
    0,
    Math.min(taskCount - 1, viewState.selectedTaskIndex + direction)
  );
}

export function navigateSwarm(
  viewState: MessengerViewState,
  direction: 1 | -1,
  swarmCount: number
): void {
  if (swarmCount === 0) return;
  viewState.selectedSwarmIndex = Math.max(
    0,
    Math.min(swarmCount - 1, viewState.selectedSwarmIndex + direction)
  );
}
