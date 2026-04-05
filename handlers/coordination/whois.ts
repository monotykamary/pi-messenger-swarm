import type { Dirs, MessengerState, AgentRegistration } from '../../lib.js';
import {
  STATUS_INDICATORS,
  agentHasTask,
  buildSelfRegistration,
  computeStatus,
  formatDuration,
} from '../../lib.js';
import { displayChannelLabel } from '../../channel.js';
import * as store from '../../store.js';
import * as taskStore from '../../swarm/task-store.js';
import { getEffectiveSessionId } from '../../store/shared.js';
import { formatFeedLine, readFeedEvents } from '../../feed.js';
import { notRegisteredError, result } from '../result.js';

export function executeWhois(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  name: string,
  config?: { stuckThreshold?: number }
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const thresholdMs = (config?.stuckThreshold ?? 900) * 1000;

  const agents = store.getActiveAgents(state, dirs);
  const agent = agents.find((a) => a.name === name);
  if (!agent) {
    if (name === state.agentName) {
      return executeWhoisSelf(state, dirs, cwd, thresholdMs);
    }
    return result(`Agent "${name}" not found or not active.`, {
      mode: 'whois',
      error: 'not_found',
      name,
    });
  }

  return formatWhoisOutput(
    agent,
    false,
    dirs,
    cwd,
    thresholdMs,
    getEffectiveSessionId(cwd, state),
    state.currentChannel
  );
}

function executeWhoisSelf(state: MessengerState, dirs: Dirs, cwd: string, thresholdMs: number) {
  return formatWhoisOutput(
    buildSelfRegistration(state),
    true,
    dirs,
    cwd,
    thresholdMs,
    getEffectiveSessionId(cwd, state),
    state.currentChannel
  );
}

function formatWhoisOutput(
  agent: AgentRegistration,
  isSelf: boolean,
  dirs: Dirs,
  cwd: string,
  thresholdMs: number,
  sessionId: string,
  fallbackChannel: string
) {
  const sessionTasks = taskStore.getTasks(cwd, sessionId);
  const hasTask = agentHasTask(agent.name, sessionTasks);

  const computed = computeStatus(
    agent.activity?.lastActivityAt ?? agent.startedAt,
    hasTask,
    (agent.reservations?.length ?? 0) > 0,
    thresholdMs
  );

  const indicator = STATUS_INDICATORS[computed.status];
  const statusLabel = computed.status.charAt(0).toUpperCase() + computed.status.slice(1);
  const idleStr = computed.idleFor ? ` for ${computed.idleFor}` : '';

  const sessionAge = formatDuration(Date.now() - new Date(agent.startedAt).getTime());
  const tokens = agent.session?.tokens ?? 0;
  const tokenStr = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;

  const lines: string[] = [];
  lines.push(`# ${agent.name}${isSelf ? ' (you)' : ''}`, '');
  lines.push(`${indicator} ${statusLabel}${idleStr}`);
  if (agent.model) lines.push(`Model: ${agent.model}`);
  if (agent.gitBranch) lines.push(`Branch: ${agent.gitBranch}`);
  if (agent.currentChannel) lines.push(`Channel: ${displayChannelLabel(agent.currentChannel)}`);
  lines.push(
    `Session: ${sessionAge} - ${agent.session?.toolCalls ?? 0} tool calls - ${tokenStr} tokens`
  );

  if (agent.statusMessage) {
    lines.push(`Status: ${agent.statusMessage}`);
  }

  if (agent.reservations && agent.reservations.length > 0) {
    lines.push('', '## Reservations');
    for (const r of agent.reservations) {
      lines.push(`- ${r.pattern}${r.reason ? ` (${r.reason})` : ''}`);
    }
  }

  if (agent.session?.filesModified && agent.session.filesModified.length > 0) {
    lines.push('', '## Recent Files');
    for (const f of agent.session.filesModified.slice(-10)) {
      lines.push(`- ${f}`);
    }
  }

  const feedCwd = isSelf ? cwd : agent.cwd;
  const feedChannel = agent.currentChannel ?? agent.sessionChannel ?? fallbackChannel;
  const allFeedEvents = readFeedEvents(feedCwd, 100, feedChannel);
  const agentEvents = allFeedEvents.filter((e) => e.agent === agent.name).slice(-10);
  if (agentEvents.length > 0) {
    lines.push('', '## Recent Activity');
    for (const e of agentEvents) {
      lines.push(`- ${formatFeedLine(e)}`);
    }
  }

  return result(lines.join('\n'), { mode: 'whois', agent });
}
