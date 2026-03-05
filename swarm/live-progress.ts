import type { AgentProgress } from "./progress.js";

export interface LiveWorkerInfo {
  cwd: string;
  taskId: string;
  agent: string;
  name: string;
  progress: AgentProgress;
  startedAt: number;
}

const liveWorkers = new Map<string, LiveWorkerInfo>();
const listeners = new Set<() => void>();

// Throttle notifications to prevent flickering from rapid updates
const MIN_NOTIFY_INTERVAL_MS = 100;
let lastNotifyTime = 0;
let pendingNotify = false;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function getWorkerKey(cwd: string, taskId: string): string {
  return `${cwd}::${taskId}`;
}

// Deep equality check for AgentProgress to avoid unnecessary re-renders
function progressEqual(a: AgentProgress, b: AgentProgress): boolean {
  if (a.toolCallCount !== b.toolCallCount) return false;
  if (a.tokens !== b.tokens) return false;
  if (a.currentTool !== b.currentTool) return false;
  if (a.currentToolArgs !== b.currentToolArgs) return false;
  if (a.recentTools.length !== b.recentTools.length) return false;
  for (let i = 0; i < a.recentTools.length; i++) {
    if (a.recentTools[i].tool !== b.recentTools[i].tool) return false;
    if (a.recentTools[i].args !== b.recentTools[i].args) return false;
  }
  return true;
}

// Check if worker info has meaningfully changed
function workerInfoChanged(
  existing: LiveWorkerInfo | undefined,
  newInfo: Omit<LiveWorkerInfo, "cwd">
): boolean {
  if (!existing) return true;
  if (existing.name !== newInfo.name) return true;
  if (existing.agent !== newInfo.agent) return true;
  if (!progressEqual(existing.progress, newInfo.progress)) return true;
  return false;
}

export function updateLiveWorker(cwd: string, taskId: string, info: Omit<LiveWorkerInfo, "cwd">): void {
  const key = getWorkerKey(cwd, taskId);
  const existing = liveWorkers.get(key);

  // Only update and notify if something meaningful changed
  if (!workerInfoChanged(existing, info)) {
    return;
  }

  liveWorkers.set(key, {
    ...info,
    cwd,
  });
  throttledNotify();
}

function throttledNotify(): void {
  const now = Date.now();
  const timeSinceLastNotify = now - lastNotifyTime;

  if (timeSinceLastNotify >= MIN_NOTIFY_INTERVAL_MS) {
    // Enough time has passed, notify immediately
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    pendingNotify = false;
    lastNotifyTime = now;
    notifyListeners();
  } else if (!pendingNotify) {
    // Schedule a notification for later
    pendingNotify = true;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      pendingNotify = false;
      lastNotifyTime = Date.now();
      notifyListeners();
    }, MIN_NOTIFY_INTERVAL_MS - timeSinceLastNotify);
  }
  // If pendingNotify is true, a notification is already scheduled
}

export function removeLiveWorker(cwd: string, taskId: string): void {
  const key = getWorkerKey(cwd, taskId);
  if (liveWorkers.has(key)) {
    liveWorkers.delete(key);
    throttledNotify();
  }
}

export function getLiveWorkers(cwd?: string): ReadonlyMap<string, LiveWorkerInfo> {
  if (!cwd) return new Map(liveWorkers);

  const filtered = new Map<string, LiveWorkerInfo>();
  for (const info of liveWorkers.values()) {
    if (info.cwd !== cwd) continue;
    filtered.set(info.taskId, info);
  }
  return filtered;
}

export function hasLiveWorkers(cwd?: string): boolean {
  if (!cwd) return liveWorkers.size > 0;
  for (const info of liveWorkers.values()) {
    if (info.cwd === cwd) return true;
  }
  return false;
}

export function onLiveWorkersChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notifyListeners(): void {
  for (const fn of listeners) fn();
}
