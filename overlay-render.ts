import { truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
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
} from "./lib.js";
import * as store from "./store.js";
import * as swarmStore from "./swarm/store.js";
import type { SwarmTask as Task } from "./swarm/types.js";
import { getLiveWorkers, type LiveWorkerInfo } from "./crew/live-progress.js";
import type { ToolEntry } from "./crew/utils/progress.js";
import { formatFeedLine as sharedFormatFeedLine, sanitizeFeedEvent, type FeedEvent } from "./feed.js";
import { loadConfig } from "./config.js";
import type { CrewViewState } from "./overlay-actions.js";

const STATUS_ICONS: Record<string, string> = { done: "✓", in_progress: "●", todo: "○", blocked: "✗" };

function formatElapsed(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `0:${String(s).padStart(2, "0")}`;
}

function renderActivityLog(
  tools: ToolEntry[],
  currentTool: string | undefined,
  currentToolArgs: string | undefined,
  startedAt: number,
  width: number,
): string[] {
  const lines: string[] = [];
  for (const entry of tools) {
    const elapsed = formatElapsed(entry.startMs - startedAt);
    const args = entry.args ? ` ${entry.args}` : "";
    lines.push(truncateToWidth(`  [${elapsed}] ${entry.tool}${args}`, width));
  }
  if (currentTool) {
    const elapsed = formatElapsed(Date.now() - startedAt);
    const args = currentToolArgs ? ` ${currentToolArgs}` : "";
    lines.push(truncateToWidth(`  → [${elapsed}] ${currentTool}${args}`, width));
  } else {
    lines.push("  → thinking...");
  }
  return lines;
}

function hasLiveWorker(cwd: string, taskId: string): boolean {
  return getLiveWorkers(cwd).has(taskId);
}

function appendUniversalHints(text: string): string {
  return `${text}  [T:snap] [B:bg]`;
}

function idleLabel(timestamp: string | undefined): string {
  if (!timestamp) return "idle";
  const ageMs = Math.max(0, Date.now() - new Date(timestamp).getTime());
  if (!Number.isFinite(ageMs) || ageMs < 30_000) return "active";
  return `idle ${formatDuration(ageMs)}`;
}

export function renderStatusBar(_theme: Theme, cwd: string, width: number): string {
  const summary = swarmStore.getSummary(cwd);
  const ready = swarmStore.getReadyTasks(cwd);
  const liveCount = getLiveWorkers(cwd).size;

  if (summary.total === 0) {
    return truncateToWidth(`No swarm tasks │ ⚙ ${liveCount} live`, width);
  }

  let line = `Swarm ${summary.done}/${summary.total}`;
  line += ` │ ready ${ready.length}`;
  line += ` │ in progress ${summary.in_progress}`;
  line += ` │ blocked ${summary.blocked}`;
  line += ` │ ⚙ ${liveCount} live`;

  return truncateToWidth(line, width);
}

export function renderWorkersSection(theme: Theme, cwd: string, width: number, maxLines: number): string[] {
  if (maxLines <= 0) return [];

  const workers = Array.from(getLiveWorkers(cwd).values()).slice(0, maxLines);
  if (workers.length === 0) return [];

  const lines: string[] = [];
  for (const info of workers) {
    const activity = info.progress.currentTool
      ? `${info.progress.currentTool}${info.progress.currentToolArgs ? `(${info.progress.currentToolArgs})` : ""}`
      : "thinking";
    const elapsed = formatDuration(Date.now() - info.startedAt);
    const tokens = info.progress.tokens > 1000
      ? `${(info.progress.tokens / 1000).toFixed(0)}k`
      : `${info.progress.tokens}`;
    const line = `⚡ ${info.name} (${info.taskId})  ${activity}  ${theme.fg("dim", `${elapsed}  ${tokens} tok`)}`;
    lines.push(truncateToWidth(line, width));
  }
  return lines;
}

export function renderTaskList(theme: Theme, cwd: string, width: number, height: number, viewState: CrewViewState): string[] {
  const tasks = swarmStore.getTasks(cwd);
  const lines: string[] = [];

  if (tasks.length === 0) {
    lines.push(theme.fg("dim", "(no tasks yet)"));
    while (lines.length < height) lines.push("");
    return lines.slice(0, height);
  }

  viewState.selectedTaskIndex = Math.max(0, Math.min(viewState.selectedTaskIndex, tasks.length - 1));

  for (let i = 0; i < tasks.length; i++) {
    lines.push(renderTaskLine(theme, tasks[i], i === viewState.selectedTaskIndex, width, getLiveWorkers(cwd).get(tasks[i].id)));
  }

  if (lines.length <= height) {
    viewState.scrollOffset = 0;
    return lines;
  }

  const selectedLine = Math.min(viewState.selectedTaskIndex, lines.length - 1);
  if (selectedLine < viewState.scrollOffset) {
    viewState.scrollOffset = selectedLine;
  } else if (selectedLine >= viewState.scrollOffset + height) {
    viewState.scrollOffset = selectedLine - height + 1;
  }

  viewState.scrollOffset = Math.max(0, Math.min(viewState.scrollOffset, lines.length - height));
  return lines.slice(viewState.scrollOffset, viewState.scrollOffset + height);
}

export function renderTaskSummary(theme: Theme, cwd: string, width: number, height: number): string[] {
  const tasks = swarmStore.getTasks(cwd);
  const counts: Record<string, number> = { done: 0, in_progress: 0, blocked: 0, todo: 0 };
  const activeNames: string[] = [];

  for (const task of tasks) {
    counts[task.status] = (counts[task.status] || 0) + 1;
    if (task.status === "in_progress" && task.claimed_by) activeNames.push(task.claimed_by);
  }

  const parts: string[] = [];
  if (counts.done > 0) parts.push(theme.fg("accent", `${counts.done} done`));
  if (counts.in_progress > 0) parts.push(theme.fg("warning", `${counts.in_progress} active`));
  if (counts.blocked > 0) parts.push(theme.fg("error", `${counts.blocked} blocked`));
  if (counts.todo > 0) parts.push(theme.fg("dim", `${counts.todo} todo`));

  const line1 = truncateToWidth(`Tasks: ${parts.join("  ")}  (${tasks.length} total)`, width);
  const line2 = activeNames.length > 0
    ? truncateToWidth(theme.fg("dim", `  Active: ${activeNames.join(", ")}`), width)
    : "";

  const lines = [line1];
  if (line2) lines.push(line2);
  while (lines.length < height) lines.push("");
  return lines.slice(0, height);
}

const DIM_EVENTS = new Set(["join", "leave", "reserve", "release"]);

export function renderFeedSection(theme: Theme, events: FeedEvent[], width: number, lastSeenTs: string | null): string[] {
  if (events.length === 0) return [];
  const lines: string[] = [];
  let lastWasMessage = false;

  for (const event of events) {
    const sanitized = sanitizeFeedEvent(event);
    const isNew = lastSeenTs === null || sanitized.ts > lastSeenTs;
    const isMessage = sanitized.type === "message";

    if (lines.length > 0 && isMessage !== lastWasMessage) {
      lines.push(theme.fg("dim", "  ·"));
    }

    if (isMessage) {
      lines.push(...renderMessageLines(theme, sanitized, width));
    } else {
      const formatted = sharedFormatFeedLine(sanitized);
      const dimmed = DIM_EVENTS.has(sanitized.type) || !isNew;
      lines.push(truncateToWidth(dimmed ? theme.fg("dim", formatted) : formatted, width));
    }
    lastWasMessage = isMessage;
  }
  return lines;
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
    let breakAt = remaining.lastIndexOf(" ", maxWidth);
    if (breakAt <= 0) breakAt = maxWidth;
    lines.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).trimStart();
  }
  return lines;
}

function renderMessageLines(theme: Theme, event: FeedEvent, width: number): string[] {
  const time = new Date(event.ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  const agentStyled = coloredAgentName(event.agent);
  const rawPreview = event.preview?.trim() ?? "";

  const direction = event.target ? `→ ${event.target}` : "✦";
  const singleLen = time.length + 1 + event.agent.length + 1 + (event.target ? 2 + event.target.length : 1) + (rawPreview ? 1 + rawPreview.length : 0);

  if (singleLen <= width && rawPreview) {
    return [truncateToWidth(`${time} ${agentStyled} ${theme.fg("accent", direction)} ${rawPreview}`, width)];
  }

  const header = `${time} ${agentStyled} ${theme.fg("accent", direction)}`;
  if (!rawPreview) return [truncateToWidth(header, width)];

  const indent = "      ";
  const maxBody = width - indent.length;
  const wrapped = wrapText(rawPreview, maxBody);
  const result = [truncateToWidth(header, width)];
  for (const bodyLine of wrapped) {
    result.push(truncateToWidth(`${indent}${bodyLine}`, width));
  }
  return result;
}

export function renderAgentsRow(
  cwd: string,
  width: number,
  state: MessengerState,
  dirs: Dirs,
  stuckThresholdMs: number,
): string {
  const allClaims = store.getClaims(dirs);
  const rowParts: string[] = [];
  const seen = new Set<string>();

  const self = buildSelfRegistration(state);
  rowParts.push(`🟢 You (${idleLabel(self.activity?.lastActivityAt ?? self.startedAt)})`);
  seen.add(self.name);

  for (const agent of store.getActiveAgents(state, dirs)) {
    if (seen.has(agent.name)) continue;
    const computed = computeStatus(
      agent.activity?.lastActivityAt ?? agent.startedAt,
      agentHasTask(agent.name, allClaims, swarmStore.getTasks(agent.cwd)),
      (agent.reservations?.length ?? 0) > 0,
      stuckThresholdMs,
    );
    const indicator = STATUS_INDICATORS[computed.status];
    const idle = computed.idleFor ? ` ${computed.idleFor}` : "";
    rowParts.push(`${indicator} ${coloredAgentName(agent.name)}${idle}`);
    seen.add(agent.name);
  }

  for (const worker of getLiveWorkers(cwd).values()) {
    if (seen.has(worker.taskId)) continue;
    rowParts.push(`🔵 ${worker.name} (${worker.taskId})`);
    seen.add(worker.taskId);
  }

  return truncateToWidth(rowParts.join("  "), width);
}

export function renderEmptyState(theme: Theme, cwd: string, width: number, height: number): string[] {
  const lines: string[] = [];
  const config = loadConfig(cwd);

  lines.push("No swarm tasks yet — create one or spawn a specialist.");
  lines.push("task.create: pi_messenger({ action: \"task.create\", title: \"Investigate bug\" })");
  lines.push("spawn: pi_messenger({ action: \"spawn\", role: \"Researcher\", message: \"Analyze issue\" })");
  lines.push(`stuck ${config.stuckThreshold}s · feed ${config.feedRetention}`);

  if (lines.length > height) {
    return lines.slice(0, height).map(line => truncateToWidth(line, width));
  }
  while (lines.length < height) lines.push("");
  return lines.map(line => truncateToWidth(line, width));
}

export function renderLegend(
  theme: Theme,
  cwd: string,
  width: number,
  viewState: CrewViewState,
  task: Task | null,
): string {
  if (viewState.confirmAction) {
    const text = renderConfirmBar(viewState.confirmAction.taskId, viewState.confirmAction.label, viewState.confirmAction.type);
    return truncateToWidth(theme.fg("warning", appendUniversalHints(text)), width);
  }

  if (viewState.inputMode === "block-reason") {
    const text = renderBlockReasonBar(viewState.blockReasonInput);
    return truncateToWidth(theme.fg("warning", appendUniversalHints(text)), width);
  }

  if (viewState.inputMode === "message") {
    const text = renderMessageBar(viewState.messageInput);
    return truncateToWidth(theme.fg("accent", text + "  [^T] [^B]"), width);
  }

  if (viewState.notification) {
    if (Date.now() < viewState.notification.expiresAt) {
      return truncateToWidth(appendUniversalHints(viewState.notification.message), width);
    }
    viewState.notification = null;
  }

  if (viewState.mode === "detail" && task) {
    return truncateToWidth(theme.fg("dim", appendUniversalHints(renderDetailStatusBar(cwd, task))), width);
  }

  if (task) {
    return truncateToWidth(theme.fg("dim", appendUniversalHints(renderListStatusBar(cwd, task))), width);
  }

  const feedHint = viewState.feedFocus ? "PgUp/PgDn:Scroll" : "f:Feed";
  return truncateToWidth(theme.fg("dim", appendUniversalHints(`m:Chat  ${feedHint}  Esc:Close`)), width);
}

export function renderDetailView(cwd: string, task: Task, width: number, height: number, viewState: CrewViewState): string[] {
  const live = getLiveWorkers(cwd).get(task.id);

  const lines: string[] = [];
  const tokens = live ? (live.progress.tokens > 1000 ? `${(live.progress.tokens / 1000).toFixed(0)}k` : `${live.progress.tokens}`) : "";
  const elapsed = live ? formatElapsed(Date.now() - live.startedAt) : "";

  lines.push(`${task.id}: ${task.title}`);
  if (live) {
    lines.push(`Status: ${task.status}  │  ${live.name}  │  ${live.progress.toolCallCount} calls  ${tokens} tokens  ${elapsed}`);
  } else {
    const claimedText = task.claimed_by ? `  │  Claimed: ${task.claimed_by}` : "";
    lines.push(`Status: ${task.status}  │  Attempts: ${task.attempt_count}  │  Created: ${formatRelativeTime(task.created_at)}${claimedText}`);
  }
  lines.push("");

  if (task.status === "in_progress" && !live) {
    const startedText = task.claimed_at ? ` (claimed ${formatRelativeTime(task.claimed_at)})` : "";
    lines.push(`⚠ Claimed but no live worker${startedText}`);
    lines.push("");
  }

  if (live) {
    const activityLines = renderActivityLog(
      live.progress.recentTools,
      live.progress.currentTool,
      live.progress.currentToolArgs,
      live.startedAt,
      width,
    );
    lines.push(...activityLines);
  } else {
    if (task.depends_on.length > 0) {
      lines.push("Dependencies:");
      for (const depId of task.depends_on) {
        const dep = swarmStore.getTask(cwd, depId);
        if (!dep) lines.push(`  ○ ${depId}: (missing)`);
        else lines.push(`  ${dep.status === "done" ? "✓" : "○"} ${dep.id}: ${dep.title} (${dep.status})`);
      }
      lines.push("");
    }

    const progress = swarmStore.getTaskProgress(cwd, task.id);
    if (progress) {
      lines.push("Progress:");
      for (const line of progress.trimEnd().split("\n")) lines.push(`  ${line}`);
      lines.push("");
    }

    if (task.status === "blocked") {
      lines.push(`Block Reason: ${task.blocked_reason ?? "Unknown"}`);
      const blockContext = swarmStore.getBlockContext(cwd, task.id);
      if (blockContext) {
        lines.push("", "Block Context:");
        for (const line of blockContext.trimEnd().split("\n")) lines.push(`  ${line}`);
      }
      lines.push("");
    }

    if (task.status === "done") {
      lines.push(`Completion Summary: ${task.summary ?? "(none)"}`);
      const evidence = task.evidence;
      if (evidence && (evidence.commits?.length || evidence.tests?.length || evidence.prs?.length)) {
        lines.push("Evidence:");
        if (evidence.commits?.length) lines.push(`  Commits: ${evidence.commits.join(", ")}`);
        if (evidence.tests?.length) lines.push(`  Tests: ${evidence.tests.join(", ")}`);
        if (evidence.prs?.length) lines.push(`  PRs: ${evidence.prs.join(", ")}`);
      }
      lines.push("");
    }

    lines.push("Spec:");
    const spec = swarmStore.getTaskSpec(cwd, task.id);
    if (!spec || spec.trimEnd().length === 0) lines.push("  *No spec available*");
    else for (const line of spec.trimEnd().split("\n")) lines.push(`  ${line}`);
  }

  const maxScroll = Math.max(0, lines.length - height);
  if (live && viewState.detailAutoScroll) {
    viewState.detailScroll = maxScroll;
  }
  viewState.detailScroll = Math.max(0, Math.min(viewState.detailScroll, maxScroll));
  const visible = lines.slice(viewState.detailScroll, viewState.detailScroll + height).map(line => truncateToWidth(line, width));
  while (visible.length < height) visible.push("");
  return visible;
}

function renderDetailStatusBar(cwd: string, task: Task): string {
  const hints: string[] = [];
  if (task.status === "in_progress") hints.push("q:Stop");
  if (["done", "blocked", "in_progress"].includes(task.status)) hints.push("r:Reset");
  if (task.status === "blocked") hints.push("u:Unblock");
  if (task.status === "todo") hints.push("s:Claim");
  if (task.status === "in_progress") hints.push("b:Block");
  if (!(task.status === "in_progress" && hasLiveWorker(cwd, task.id))) hints.push("x:Del");
  hints.push("m:Chat", "f:Feed", "PgUp/PgDn:Scroll", "←→:Nav");
  return hints.join("  ");
}

function renderListStatusBar(cwd: string, task: Task): string {
  const hints: string[] = ["Enter:Detail"];
  if (task.status === "in_progress") hints.push("q:Stop");
  if (["done", "blocked", "in_progress"].includes(task.status)) hints.push("r:Reset");
  if (task.status === "blocked") hints.push("u:Unblock");
  if (task.status === "todo") hints.push("s:Claim");
  if (task.status === "in_progress") hints.push("b:Block");
  if (!(task.status === "in_progress" && hasLiveWorker(cwd, task.id))) hints.push("x:Del");
  hints.push("m:Chat", "f:Feed", "PgUp/PgDn:Scroll");
  return hints.join("  ");
}

function renderConfirmBar(taskId: string, label: string, type: "reset" | "cascade-reset" | "delete"): string {
  if (type === "reset") return `⚠ Reset ${taskId} "${label}"? [y] Confirm  [n] Cancel`;
  if (type === "cascade-reset") return `⚠ Cascade reset ${taskId} and dependents? [y] Confirm  [n] Cancel`;
  return `⚠ Delete ${taskId} "${label}"? [y] Confirm  [n] Cancel`;
}

function renderBlockReasonBar(input: string): string {
  return `Block reason: ${input}█  [Enter] Confirm  [Esc] Cancel`;
}

function renderMessageBar(input: string): string {
  const isAt = input.startsWith("@");
  const hint = isAt ? "DM" : "broadcast";
  const tabHint = isAt && !input.includes(" ") ? "  [Tab] Complete" : "";
  return `${hint}: ${input}█  [Enter] Send${tabHint}  [Esc] Cancel`;
}

function renderTaskLine(theme: Theme, task: Task, isSelected: boolean, width: number, liveWorker?: LiveWorkerInfo): string {
  const select = isSelected ? theme.fg("accent", "▸ ") : "  ";
  const icon = STATUS_ICONS[task.status] ?? "?";
  const coloredIcon = task.status === "done"
    ? theme.fg("accent", icon)
    : task.status === "in_progress"
      ? theme.fg("warning", icon)
      : task.status === "blocked"
        ? theme.fg("error", icon)
        : theme.fg("dim", icon);

  let suffix = "";
  if (task.status === "in_progress" && liveWorker) {
    suffix = ` (${liveWorker.name})`;
  } else if (task.status === "in_progress" && task.claimed_by) {
    suffix = ` (${task.claimed_by})`;
  } else if (task.status === "todo" && task.depends_on.length > 0) {
    suffix = ` → ${task.depends_on.join(", ")}`;
  } else if (task.status === "blocked" && task.blocked_reason) {
    const reason = task.blocked_reason.slice(0, 28);
    suffix = ` [${reason}${task.blocked_reason.length > 28 ? "…" : ""}]`;
  }

  return truncateToWidth(`${select}${coloredIcon} ${task.id}  ${task.title}${theme.fg("dim", suffix)}`, width);
}

export function navigateTask(viewState: CrewViewState, direction: 1 | -1, taskCount: number): void {
  if (taskCount === 0) return;
  viewState.selectedTaskIndex = Math.max(0, Math.min(taskCount - 1, viewState.selectedTaskIndex + direction));
}
