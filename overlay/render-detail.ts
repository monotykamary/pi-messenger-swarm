import { truncateToWidth, visibleWidth } from '@mariozechner/pi-tui';
import type { Theme } from '@mariozechner/pi-coding-agent';
import {
  formatDuration,
  formatRelativeTime,
  buildSelfRegistration,
  coloredAgentName,
  computeStatus,
  STATUS_INDICATORS,
  agentHasTask,
  type Dirs,
  type MessengerState,
} from '../lib.js';
import * as store from '../store.js';
import * as taskStore from '../swarm/task-store.js';
import type { SwarmTask as Task, SpawnedAgent } from '../swarm/types.js';
import { formatRoleLabel } from '../swarm/labels.js';
import { getLiveWorkers, type LiveWorkerInfo } from '../swarm/live-progress.js';
import type { ToolEntry } from '../swarm/progress.js';
import { loadConfig } from '../config.js';
import type { MessengerViewState } from '../overlay-actions.js';

let listLegendCache: {
  task: Task;
  width: number;
  line: string;
} | null = null;

function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, '0')}` : `0:${String(s).padStart(2, '0')}`;
}

function renderActivityLog(
  tools: ToolEntry[],
  currentTool: string | undefined,
  currentToolArgs: string | undefined,
  startedAt: number,
  width: number
): string[] {
  const lines: string[] = [];
  for (const entry of tools) {
    const elapsed = formatElapsed(entry.startMs - startedAt);
    const args = entry.args ? ` ${entry.args}` : '';
    lines.push(truncateToWidth(`  [${elapsed}] ${entry.tool}${args}`, width));
  }
  if (currentTool) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const args = currentToolArgs ? ` ${currentToolArgs}` : '';
    lines.push(truncateToWidth(`  → [${elapsed}] ${currentTool}${args}`, width));
  } else {
    lines.push('  → thinking...');
  }
  return lines;
}

function appendUniversalHints(text: string): string {
  return `${text}  [T:snap] [B:bg]`;
}

function idleLabel(timestamp: string | undefined): string {
  if (!timestamp) return 'idle';
  const ageMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return 'active';
  return `idle ${formatDuration(ageMs)}`;
}

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) return [text];
  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxWidth) {
      lines.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf(' ', maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

export function renderAgentsRow(
  cwd: string,
  width: number,
  state: MessengerState,
  dirs: Dirs,
  stuckThresholdMs: number,
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo> = getLiveWorkers(cwd)
): string {
  const activeAgents = store.getActiveAgents(state, dirs);
  const rowParts: string[] = [];
  const seen = new Set<string>();
  const sessionId = state.contextSessionId ?? '';
  const sessionTasks = taskStore.getTasks(cwd, sessionId);

  const self = buildSelfRegistration(state);
  rowParts.push(`🟢 You (${idleLabel(self.activity?.lastActivityAt ?? self.startedAt)})`);
  seen.add(self.name);

  for (const agent of activeAgents) {
    if (seen.has(agent.name)) continue;
    const computed = computeStatus(
      agent.activity?.lastActivityAt ?? agent.startedAt,
      agentHasTask(agent.name, sessionTasks),
      (agent.reservations?.length ?? 0) > 0,
      stuckThresholdMs
    );
    const indicator = STATUS_INDICATORS[computed.status];
    const idle = computed.idleFor ? ` ${computed.idleFor}` : '';
    rowParts.push(`${indicator} ${coloredAgentName(agent.name)}${idle}`);
    seen.add(agent.name);
  }

  for (const worker of liveWorkers.values()) {
    if (seen.has(worker.name)) continue;
    rowParts.push(`🔵 ${worker.name} (${worker.taskId})`);
    seen.add(worker.name);
  }

  return truncateToWidth(rowParts.join('  '), width);
}

export function renderEmptyState(
  theme: Theme,
  cwd: string,
  width: number,
  height: number,
  channelId: string
): string[] {
  const lines: string[] = [];
  const config = loadConfig(cwd);

  lines.push(theme.fg('dim', 'No swarm tasks yet — create one or spawn a specialist.'));
  lines.push(
    theme.fg(
      'dim',
      'task.create: pi_messenger({ action: "task.create", title: "Investigate bug" })'
    )
  );
  lines.push(
    theme.fg(
      'dim',
      'spawn: pi_messenger({ action: "spawn", role: "Researcher", message: "Analyze issue" })'
    )
  );
  lines.push(theme.fg('dim', `stuck ${config.stuckThreshold}s · feed ${config.feedRetention}`));

  if (lines.length > height) {
    return lines.slice(0, height).map((line) => truncateToWidth(line, width));
  }
  while (lines.length < height) lines.push('');
  return lines.map((line) => truncateToWidth(line, width));
}

export function renderLegend(
  theme: Theme,
  cwd: string,
  width: number,
  viewState: MessengerViewState,
  task: Task | null,
  swarmAgent: SpawnedAgent | null,
  channelId: string
): string[] {
  if (viewState.confirmAction) {
    const text = renderConfirmBar(
      viewState.confirmAction.taskId,
      viewState.confirmAction.label,
      viewState.confirmAction.type
    );
    return [truncateToWidth(theme.fg('warning', appendUniversalHints(text)), width)];
  }

  if (viewState.inputMode === 'block-reason') {
    const text = renderBlockReasonBar(viewState.blockReasonInput);
    return [truncateToWidth(theme.fg('warning', appendUniversalHints(text)), width)];
  }

  if (viewState.inputMode === 'message') {
    const lines = renderMessageBar(viewState.messageInput, width);
    return lines.map((line) => theme.fg('accent', line));
  }

  if (viewState.notification) {
    if (Date.now() < viewState.notification.expiresAt) {
      return [truncateToWidth(appendUniversalHints(viewState.notification.message), width)];
    }
    viewState.notification = null;
  }

  if (viewState.mainView === 'swarm') {
    if (viewState.mode === 'detail' && swarmAgent) {
      return [
        truncateToWidth(theme.fg('dim', appendUniversalHints(renderSwarmDetailStatusBar())), width),
      ];
    }
    return [
      truncateToWidth(
        theme.fg('dim', appendUniversalHints(renderSwarmListStatusBar(!!swarmAgent))),
        width
      ),
    ];
  }

  if (viewState.mode === 'detail' && task) {
    return [
      truncateToWidth(
        theme.fg('dim', appendUniversalHints(renderDetailStatusBar(cwd, task))),
        width
      ),
    ];
  }

  if (task) {
    if (listLegendCache && listLegendCache.task === task && listLegendCache.width === width) {
      return [listLegendCache.line];
    }
    const line = truncateToWidth(
      theme.fg('dim', appendUniversalHints(renderListStatusBar(cwd, task))),
      width
    );
    listLegendCache = { task, width, line };
    return [line];
  }

  return [
    truncateToWidth(
      theme.fg(
        'dim',
        appendUniversalHints('c/C:Channel  m:Chat  f:Swarm  j/k/gg/G:Feed  e:Expand  Esc:Close')
      ),
      width
    ),
  ];
}

export function renderDetailView(
  cwd: string,
  task: Task,
  width: number,
  height: number,
  viewState: MessengerViewState,
  channelId: string,
  sessionId: string = '',
  liveWorkers: ReadonlyMap<string, LiveWorkerInfo> = getLiveWorkers(cwd)
): string[] {
  const live = liveWorkers.get(task.id);

  const lines: string[] = [];
  const tokens = live
    ? live.progress.tokens > 1000
      ? `${(live.progress.tokens / 1000).toFixed(0)}k`
      : `${live.progress.tokens}`
    : '';
  const elapsed = live ? formatElapsed(Date.now() - live.startedAt) : '';

  lines.push(`${task.id}: ${task.title}`);
  if (live) {
    lines.push(
      `Status: ${task.status}  │  ${live.name}  │  ${live.progress.toolCallCount} calls  ${tokens} tokens  ${elapsed}`
    );
  } else {
    const claimedText = task.claimed_by ? `  │  Claimed: ${task.claimed_by}` : '';
    lines.push(
      `Status: ${task.status}  │  Attempts: ${task.attempt_count}  │  Created: ${formatRelativeTime(task.created_at)}${claimedText}`
    );
  }
  lines.push('');

  if (task.status === 'in_progress' && !live) {
    const startedText = task.claimed_at ? ` (claimed ${formatRelativeTime(task.claimed_at)})` : '';
    lines.push(`⚠ Claimed but no live worker${startedText}`);
    lines.push('');
  }

  if (live) {
    const activityLines = renderActivityLog(
      live.progress.recentTools,
      live.progress.currentTool,
      live.progress.currentToolArgs,
      live.startedAt,
      width
    );
    lines.push(...activityLines);
  } else {
    if (task.depends_on.length > 0) {
      lines.push('Dependencies:');
      for (const depId of task.depends_on) {
        const dep = taskStore.getTask(cwd, sessionId, depId);
        if (!dep) lines.push(`  ○ ${depId}: (missing)`);
        else
          lines.push(
            `  ${dep.status === 'done' ? '✓' : '○'} ${dep.id}: ${dep.title} (${dep.status})`
          );
      }
      lines.push('');
    }

    const progress = sessionId ? taskStore.getTaskProgress(cwd, sessionId, task.id) : null;
    if (progress) {
      lines.push('Progress:');
      for (const line of progress.trimEnd().split('\n')) lines.push(`  ${line}`);
      lines.push('');
    }

    if (task.status === 'blocked') {
      lines.push(`Block Reason: ${task.blocked_reason ?? 'Unknown'}`);
      lines.push('');
    }

    if (task.status === 'done') {
      lines.push(`Completion Summary: ${task.summary ?? '(none)'}`);
      const evidence = task.evidence;
      if (
        evidence &&
        (evidence.commits?.length || evidence.tests?.length || evidence.prs?.length)
      ) {
        lines.push('Evidence:');
        if (evidence.commits?.length) lines.push(`  Commits: ${evidence.commits.join(', ')}`);
        if (evidence.tests?.length) lines.push(`  Tests: ${evidence.tests.join(', ')}`);
        if (evidence.prs?.length) lines.push(`  PRs: ${evidence.prs.join(', ')}`);
      }
      lines.push('');
    }

    lines.push('Spec:');
    const spec = sessionId ? taskStore.getTaskSpec(cwd, sessionId, task.id) : null;
    if (!spec || spec.trimEnd().length === 0) lines.push('  *No spec available*');
    else for (const line of spec.trimEnd().split('\n')) lines.push(`  ${line}`);
  }

  const maxScroll = Math.max(0, lines.length - height);
  if (live && viewState.detailAutoScroll) {
    viewState.detailScroll = maxScroll;
  }
  viewState.detailScroll = Math.max(0, Math.min(viewState.detailScroll, maxScroll));
  const visible = lines
    .slice(viewState.detailScroll, viewState.detailScroll + height)
    .map((line) => truncateToWidth(line, width));
  while (visible.length < height) visible.push('');
  return visible;
}

export function renderSwarmDetail(
  agent: SpawnedAgent,
  width: number,
  height: number,
  viewState: MessengerViewState
): string[] {
  const lines: string[] = [];

  lines.push(`${agent.name} (${agent.id})`);
  lines.push(`Role: ${formatRoleLabel(agent.role)}  │  Status: ${agent.status}`);
  if (agent.persona?.trim()) lines.push(`Persona: ${agent.persona.trim()}`);
  lines.push(`Started: ${formatRelativeTime(agent.startedAt)}`);
  if (agent.endedAt) {
    const exit = typeof agent.exitCode === 'number' ? `  │  Exit: ${agent.exitCode}` : '';
    lines.push(`Ended: ${formatRelativeTime(agent.endedAt)}${exit}`);
  }
  if (agent.taskId) lines.push(`Task: ${agent.taskId}`);

  if (agent.context?.trim()) {
    lines.push('', 'Context:');
    for (const src of agent.context.trim().split('\n')) {
      const wrapped = wrapText(src.trim() || '', Math.max(20, width - 2));
      for (const line of wrapped) lines.push(`  ${line}`);
    }
  }

  if (agent.systemPrompt?.trim()) {
    lines.push('', 'System Prompt:');
    for (const src of agent.systemPrompt.split('\n')) {
      if (src.trim().length === 0) {
        lines.push('');
        continue;
      }
      const wrapped = wrapText(src, Math.max(20, width - 2));
      for (const line of wrapped) lines.push(`  ${line}`);
    }
  }

  if (agent.error?.trim()) {
    lines.push('', 'Error:');
    for (const src of agent.error.trim().split('\n')) {
      const wrapped = wrapText(src.trim() || '', Math.max(20, width - 2));
      for (const line of wrapped) lines.push(`  ${line}`);
    }
  }

  const maxScroll = Math.max(0, lines.length - height);
  viewState.detailScroll = Math.max(0, Math.min(viewState.detailScroll, maxScroll));
  const visible = lines
    .slice(viewState.detailScroll, viewState.detailScroll + height)
    .map((line) => truncateToWidth(line, width));
  while (visible.length < height) visible.push('');
  return visible;
}

function renderDetailStatusBar(cwd: string, task: Task): string {
  const hints: string[] = [];
  if (task.status === 'in_progress') hints.push('q:Stop');
  if (task.status === 'blocked') hints.push('u:Unblock');
  if (task.status === 'todo') hints.push('s:Claim');
  if (task.status === 'in_progress') hints.push('b:Block');
  if (task.status === 'done') hints.push('x:Archive');
  hints.push('m:Chat', 'f:Swarm', 'j/k/gg/G:Feed', 'e:Expand', '←→:Nav');
  return hints.join('  ');
}

function renderListStatusBar(cwd: string, task: Task): string {
  const hints: string[] = ['Enter:Detail'];
  if (task.status === 'in_progress') hints.push('q:Stop');
  if (task.status === 'blocked') hints.push('u:Unblock');
  if (task.status === 'todo') hints.push('s:Claim');
  if (task.status === 'in_progress') hints.push('b:Block');
  if (task.status === 'done') hints.push('x:Archive');
  hints.push('m:Chat', 'f:Swarm', 'j/k/gg/G:Feed', 'e:Expand');
  return hints.join('  ');
}

function renderSwarmListStatusBar(hasAgent: boolean): string {
  const hints: string[] = [];
  if (hasAgent) hints.push('Enter:Detail');
  hints.push('m:Chat', 'f:Tasks', 'j/k/gg/G:Feed', 'e:Expand');
  return hints.join('  ');
}

function renderSwarmDetailStatusBar(): string {
  return 'Esc:Back  m:Chat  f:Tasks  j/k/gg/G:Feed  e:Expand  ←→:Nav';
}

function renderConfirmBar(
  taskId: string,
  label: string,
  type: 'reset' | 'cascade-reset' | 'delete' | 'archive'
): string {
  if (type === 'reset') return `⚠ Reset ${taskId} "${label}"? [y] Confirm  [n] Cancel`;
  if (type === 'cascade-reset')
    return `⚠ Cascade reset ${taskId} and dependents? [y] Confirm  [n] Cancel`;
  if (type === 'archive') return `⚠ Archive ${taskId} "${label}"? [y] Confirm  [n] Cancel`;
  return `⚠ Delete ${taskId} "${label}"? [y] Confirm  [n] Cancel`;
}

function renderBlockReasonBar(input: string): string {
  return `Block reason: ${input}█  [Enter] Confirm  [Esc] Cancel`;
}

function wrapInputToLines(input: string, width: number, hint: string): string[] {
  const tabHint = input.startsWith('@') && !input.includes(' ') ? '  [Tab] Complete' : '';
  const suffix = `  [Enter] Send${tabHint}  [Esc] Cancel`;
  const prefix = `${hint}: `;
  const cursor = '█';

  const suffixWidth = visibleWidth(suffix);
  const prefixWidth = visibleWidth(prefix);
  const cursorWidth = 1;

  const firstLineMaxContent = Math.max(1, width - prefixWidth);
  const lastLineMaxContent = Math.max(1, width - prefixWidth - cursorWidth - suffixWidth);
  const middleMaxContent = firstLineMaxContent;

  if (input.length <= lastLineMaxContent) {
    return [`${prefix}${input}${cursor}${suffix}`];
  }

  const lines: string[] = [];
  let remaining = input;

  const firstLineContent = remaining.slice(0, firstLineMaxContent);
  lines.push(`${prefix}${firstLineContent}`);
  remaining = remaining.slice(firstLineMaxContent);

  const indent = ' '.repeat(prefixWidth);
  while (remaining.length > lastLineMaxContent) {
    const chunk = remaining.slice(0, middleMaxContent);
    lines.push(`${indent}${chunk}`);
    remaining = remaining.slice(middleMaxContent);
  }

  lines.push(`${indent}${remaining}${cursor}${suffix}`);

  return lines;
}

function renderMessageBar(input: string, width: number): string[] {
  const isAt = input.startsWith('@');
  const hint = isAt ? 'DM' : 'channel';
  return wrapInputToLines(input, width, hint);
}
