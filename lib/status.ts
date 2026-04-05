import type {
  AgentStatus,
  ComputedStatus,
  AgentRegistration,
  MessengerState,
  AutoStatusContext,
} from './types.js';

export function computeStatus(
  lastActivityAt: string,
  hasTask: boolean,
  hasReservation: boolean,
  thresholdMs: number
): ComputedStatus {
  const elapsed = Date.now() - new Date(lastActivityAt).getTime();
  if (isNaN(elapsed) || elapsed < 0) {
    return { status: 'active' };
  }
  const ACTIVE_MS = 30_000;
  const IDLE_MS = 5 * 60_000;

  if (elapsed < ACTIVE_MS) {
    return { status: 'active' };
  }
  if (elapsed < IDLE_MS) {
    return { status: 'idle', idleFor: formatDuration(elapsed) };
  }
  if (!hasTask && !hasReservation) {
    return { status: 'away', idleFor: formatDuration(elapsed) };
  }
  if (elapsed >= thresholdMs) {
    return { status: 'stuck', idleFor: formatDuration(elapsed) };
  }
  return { status: 'idle', idleFor: formatDuration(elapsed) };
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export const STATUS_INDICATORS: Record<AgentStatus, string> = {
  active: '\u{1F7E2}',
  idle: '\u{1F7E1}',
  away: '\u{1F7E0}',
  stuck: '\u{1F534}',
};

export function generateAutoStatus(ctx: AutoStatusContext): string | undefined {
  const sessionAge = Date.now() - new Date(ctx.sessionStartedAt).getTime();

  if (sessionAge < 30_000) {
    return 'just arrived';
  }

  if (ctx.recentCommit) {
    return 'just shipped';
  }

  if (ctx.recentTestRuns >= 3) {
    return 'debugging...';
  }

  if (ctx.recentEdits >= 8) {
    return 'on fire \u{1F525}';
  }

  if (ctx.currentActivity?.startsWith('reading')) {
    return 'exploring the codebase';
  }

  if (ctx.currentActivity?.startsWith('editing')) {
    return 'deep in thought';
  }

  return undefined;
}

export function buildSelfRegistration(state: MessengerState): AgentRegistration {
  const currentChannel = state.currentChannel || state.sessionChannel;
  if (!currentChannel) {
    throw new Error('No current or session channel set');
  }
  const joinedChannels = Array.isArray(state.joinedChannels)
    ? [...state.joinedChannels]
    : [currentChannel];
  return {
    name: state.agentName,
    pid: process.pid,
    sessionId: '',
    cwd: process.cwd(),
    model: state.model,
    startedAt: state.sessionStartedAt,
    gitBranch: state.gitBranch,
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { ...state.activity },
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    statusMessage: state.statusMessage,
    currentChannel,
    sessionChannel: state.sessionChannel || currentChannel,
    joinedChannels,
  };
}

export function agentHasTask(
  name: string,
  crewTasks: Array<{ assigned_to?: string; claimed_by?: string; status: string }>
): boolean {
  return crewTasks.some(
    (t) => (t.assigned_to === name || t.claimed_by === name) && t.status === 'in_progress'
  );
}
