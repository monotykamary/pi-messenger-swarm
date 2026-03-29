import { existsSync } from 'node:fs';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  AgentMailMessage,
  AgentRegistration,
  Dirs,
  MessengerState,
  NameThemeConfig,
} from '../lib.js';
import {
  STATUS_INDICATORS,
  agentHasTask,
  buildSelfRegistration,
  computeStatus,
  displaySpecPath,
  extractFolder,
  formatDuration,
  resolveSpecPath,
  truncatePathLeft,
} from '../lib.js';
import { displayChannelLabel } from '../channel.js';
import * as store from '../store.js';
import * as swarmStore from '../swarm/store.js';
import { formatFeedLine, logFeedEvent, pruneFeed, readFeedEvents } from '../feed.js';
import { notRegisteredError, result } from './result.js';

export function executeJoin(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void,
  specPath?: string,
  nameTheme?: NameThemeConfig,
  feedRetention?: number,
  channel?: string,
  create?: boolean
) {
  state.isHuman = ctx.hasUI;
  const cwd = ctx.cwd ?? process.cwd();

  if (!state.registered) {
    if (!store.register(state, dirs, ctx, nameTheme)) {
      return result('Failed to join the agent mesh. Check logs for details.', {
        mode: 'join',
        error: 'registration_failed',
      });
    }

    if (channel) {
      const switched = store.joinChannel(state, dirs, channel, { create });
      if (!switched.success) {
        const error = (switched as Extract<typeof switched, { success: false }>).error;
        return result(
          error === 'not_found'
            ? `Channel ${displayChannelLabel(channel)} not found.`
            : `Invalid channel: ${channel}`,
          { mode: 'join', error, channel }
        );
      }
    }

    store.startWatcher(state, dirs, deliverFn);
    updateStatusFn(ctx);
    pruneFeed(cwd, feedRetention ?? 50, state.currentChannel);
    logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
  } else if (channel) {
    const switched = store.joinChannel(state, dirs, channel, { create });
    if (!switched.success) {
      const error = (switched as Extract<typeof switched, { success: false }>).error;
      return result(
        error === 'not_found'
          ? `Channel ${displayChannelLabel(channel)} not found.`
          : `Invalid channel: ${channel}`,
        { mode: 'join', error, channel }
      );
    }
    store.stopWatcher(state);
    state.chatHistory.clear();
    state.channelPostHistory = [];
    state.unreadCounts.clear();
    state.seenSenders.clear();
    state.watcherRetries = 0;
    store.startWatcher(state, dirs, deliverFn);
    updateStatusFn(ctx);

    const label = displayChannelLabel(state.currentChannel);
    const text = switched.switched ? `Switched to ${label}.` : `Already in ${label}.`;

    return result(text, {
      mode: 'join',
      alreadyJoined: !switched.switched,
      name: state.agentName,
      channel: state.currentChannel,
      joinedChannels: [...state.joinedChannels],
    });
  } else {
    const agents = store.getActiveAgents(state, dirs);
    return result(
      `Already joined as ${state.agentName} in ${displayChannelLabel(state.currentChannel)}. ${agents.length} peer${agents.length === 1 ? '' : 's'} active.`,
      {
        mode: 'join',
        alreadyJoined: true,
        name: state.agentName,
        peerCount: agents.length,
        channel: state.currentChannel,
      }
    );
  }

  let specWarning = '';
  if (specPath) {
    state.spec = resolveSpecPath(specPath, cwd);
    store.updateRegistration(state, dirs, ctx);
    if (!existsSync(state.spec)) {
      specWarning = `\n\nWarning: Spec file not found at ${displaySpecPath(state.spec, cwd)}.`;
    }
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(cwd);
  const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;
  const channelLabel = displayChannelLabel(state.currentChannel);

  let text = `Joined as ${state.agentName} in ${locationPart} on ${channelLabel}. ${agents.length} peer${agents.length === 1 ? '' : 's'} active.`;

  if (state.spec) {
    text += `\nSpec: ${displaySpecPath(state.spec, cwd)}`;
  }

  text += `\nJoined channels: ${state.joinedChannels.map(displayChannelLabel).join(', ')}`;

  if (agents.length > 0) {
    text += `\n\nActive peers: ${agents.map((a) => a.name).join(', ')}`;
    text +=
      '\n\nUse pi_messenger({ action: "list" }) for details, pi_messenger({ action: "send", to: "Name", message: "..." }) for DMs, or pi_messenger({ action: "send", to: "#memory", message: "..." }) for durable channel posts.';
  }

  if (specWarning) {
    text += specWarning;
  }

  return result(text, {
    mode: 'join',
    name: state.agentName,
    location: locationPart,
    peerCount: agents.length,
    peers: agents.map((a) => a.name),
    spec: state.spec ? displaySpecPath(state.spec, cwd) : undefined,
    channel: state.currentChannel,
    joinedChannels: [...state.joinedChannels],
  });
}

export function executeStatus(state: MessengerState, dirs: Dirs, cwd: string = process.cwd()) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(cwd);
  const location = state.gitBranch ? `${folder} (${state.gitBranch})` : folder;
  const myClaim = swarmStore
    .getTasks(cwd, state.currentChannel)
    .find((task) => task.status === 'in_progress' && task.claimed_by === state.agentName);

  let text = `You: ${state.agentName}\n`;
  text += `Location: ${location}\n`;
  text += `On: ${displayChannelLabel(state.currentChannel)}\n`;
  if (myClaim) {
    text += `Claim: ${myClaim.id}${myClaim.blocked_reason ? ` - ${myClaim.blocked_reason}` : ''}\n`;
  }

  text += `Peers: ${agents.length}\n`;
  if (state.reservations.length > 0) {
    const myRes = state.reservations.map((r) => `🔒 ${truncatePathLeft(r.pattern, 40)}`);
    text += `Reservations: ${myRes.join(', ')}\n`;
  }
  text += `Joined channels: ${state.joinedChannels.map(displayChannelLabel).join(', ')}\n`;
  text +=
    '\nUse pi_messenger({ action: "list" }) for details, pi_messenger({ action: "task.list" }) for tasks.';

  return result(text, {
    mode: 'status',
    registered: true,
    self: state.agentName,
    folder,
    gitBranch: state.gitBranch,
    peerCount: agents.length,
    channel: state.currentChannel,
    joinedChannels: [...state.joinedChannels],
    claim: myClaim
      ? {
          id: myClaim.id,
          title: myClaim.title,
          claimedBy: myClaim.claimed_by,
        }
      : undefined,
    reservations: state.reservations,
  });
}

export function executeList(
  state: MessengerState,
  dirs: Dirs,
  cwd: string = process.cwd(),
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

  const allClaims = store.getClaims(dirs);

  lines.push(
    formatAgentLine(
      buildSelfRegistration(state),
      true,
      agentHasTask(state.agentName, allClaims, swarmStore.getTasks(cwd, state.currentChannel))
    )
  );

  for (const a of peers) {
    const channel = a.currentChannel ?? a.sessionChannel ?? state.currentChannel;
    lines.push(
      formatAgentLine(
        a,
        false,
        agentHasTask(a.name, allClaims, swarmStore.getTasks(a.cwd, channel))
      )
    );
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

  return formatWhoisOutput(agent, false, dirs, cwd, thresholdMs);
}

function executeWhoisSelf(state: MessengerState, dirs: Dirs, cwd: string, thresholdMs: number) {
  return formatWhoisOutput(buildSelfRegistration(state), true, dirs, cwd, thresholdMs);
}

function formatWhoisOutput(
  agent: AgentRegistration,
  isSelf: boolean,
  dirs: Dirs,
  cwd: string,
  thresholdMs: number
) {
  const allClaims = store.getClaims(dirs);
  const agentChannel = agent.currentChannel ?? agent.sessionChannel ?? 'general';
  const hasTask = agentHasTask(agent.name, allClaims, swarmStore.getTasks(agent.cwd, agentChannel));

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
  const feedChannel = agent.currentChannel ?? agent.sessionChannel ?? 'general';
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
