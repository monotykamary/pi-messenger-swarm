import type { Dirs, MessengerState, AgentRegistration } from '../../lib.js';
import {
  STATUS_INDICATORS,
  agentHasTask,
  buildSelfRegistration,
  computeStatus,
  extractFolder,
} from '../../lib.js';
import { displayChannelLabel } from '../../channel.js';
import * as store from '../../store.js';
import * as taskStore from '../../swarm/task-store.js';
import { getEffectiveSessionId } from '../../store/shared.js';
import { formatFeedLine, readFeedEvents } from '../../feed.js';
import { notRegisteredError, result } from '../result.js';

export function executeList(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  config?: { stuckThreshold?: number }
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const thresholdMs = (config?.stuckThreshold ?? 900) * 1000;
  const peers = store.getActiveAgents(state, dirs);
  const folder = extractFolder(cwd);
  const totalCount = peers.length + 1;

  const lines: string[] = [];
  lines.push(`# Agents (${totalCount} online - project: ${folder})`, '');
  lines.push(`Current channel: ${displayChannelLabel(state.currentChannel)}`);
  lines.push(`Joined channels: ${state.joinedChannels.map(displayChannelLabel).join(', ')}`, '');

  function formatAgentLine(a: AgentRegistration, isSelf: boolean, hasTask: boolean): string {
    const computed = computeStatus(
      a.activity?.lastActivityAt ?? a.startedAt,
      hasTask,
      (a.reservations?.length ?? 0) > 0,
      thresholdMs
    );
    const indicator = STATUS_INDICATORS[computed.status];
    const nameLabel = isSelf ? `${a.name} (you)` : a.name;

    const parts: string[] = [`${indicator} ${nameLabel}`];

    if (a.activity?.currentActivity) {
      parts.push(a.activity.currentActivity);
    } else if (computed.status === 'idle' && computed.idleFor) {
      parts.push(`idle ${computed.idleFor}`);
    } else if (computed.status === 'away' && computed.idleFor) {
      parts.push(`away ${computed.idleFor}`);
    } else if (computed.status === 'stuck' && computed.idleFor) {
      parts.push(`stuck ${computed.idleFor}`);
    }

    parts.push(`${a.session?.toolCalls ?? 0} tools`);

    const tokens = a.session?.tokens ?? 0;
    if (tokens >= 1000) {
      parts.push(`${(tokens / 1000).toFixed(1)}k`);
    } else {
      parts.push(`${tokens}`);
    }

    const preferredChannel = a.currentChannel ?? a.sessionChannel;
    if (preferredChannel) {
      parts.push(displayChannelLabel(preferredChannel));
    }

    if (a.reservations && a.reservations.length > 0) {
      const resParts = a.reservations.map((r) => r.pattern).join(', ');
      parts.push(`📁 ${resParts}`);
    }

    if (a.statusMessage) {
      parts.push(a.statusMessage);
    }

    return parts.join(' - ');
  }

  const sessionId = getEffectiveSessionId(cwd, state);
  const sessionTasks = taskStore.getTasks(cwd, sessionId);

  lines.push(
    formatAgentLine(buildSelfRegistration(state), true, agentHasTask(state.agentName, sessionTasks))
  );

  for (const a of peers) {
    lines.push(formatAgentLine(a, false, agentHasTask(a.name, sessionTasks)));
  }

  const recentEvents = readFeedEvents(cwd, 5, state.currentChannel);
  if (recentEvents.length > 0) {
    lines.push('', `# Recent Activity ${displayChannelLabel(state.currentChannel)}`, '');
    for (const event of recentEvents) {
      lines.push(formatFeedLine(event));
    }
  }

  return result(lines.join('\n').trim(), {
    mode: 'list',
    registered: true,
    agents: peers,
    self: state.agentName,
    totalCount,
    channel: state.currentChannel,
  });
}
