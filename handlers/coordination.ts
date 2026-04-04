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
import { displayChannelLabel, normalizeChannelId } from '../channel.js';
import * as store from '../store.js';
import * as taskStore from '../swarm/task-store.js';
import {
  formatFeedLine,
  isSwarmEvent,
  logFeedEvent,
  pruneFeed,
  readFeedEvents,
  type FeedEvent,
} from '../feed.js';
import { notRegisteredError, result } from './result.js';

export function executeJoin(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  _deliverFn: (msg: AgentMailMessage) => void,
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
    state.chatHistory.clear();
    state.channelPostHistory = [];
    state.unreadCounts.clear();
    state.seenSenders.clear();
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
      '\n\nUse pi_messenger({ action: "list" }) for details, pi_messenger({ action: "task.list" }) for tasks.';
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
  const sessionId = state.contextSessionId ?? '';
  const myClaim = taskStore
    .getTasks(cwd, sessionId)
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

  const allClaims = store.getClaims(dirs);
  const sessionId = state.contextSessionId ?? '';
  const sessionTasks = taskStore.getTasks(cwd, sessionId);

  lines.push(
    formatAgentLine(
      buildSelfRegistration(state),
      true,
      agentHasTask(state.agentName, allClaims, sessionTasks)
    )
  );

  for (const a of peers) {
    lines.push(formatAgentLine(a, false, agentHasTask(a.name, allClaims, sessionTasks)));
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

  return formatWhoisOutput(
    agent,
    false,
    dirs,
    cwd,
    thresholdMs,
    state.contextSessionId ?? '',
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
    state.contextSessionId ?? '',
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
  const allClaims = store.getClaims(dirs);
  const sessionTasks = taskStore.getTasks(cwd, sessionId);
  const hasTask = agentHasTask(agent.name, allClaims, sessionTasks);

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

export function executeSetStatus(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  message: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  state.statusMessage = message;
  state.customStatus = true;
  store.updateRegistration(state, dirs, ctx);

  return result(`Status set to: ${message}`, { mode: 'set_status', message });
}

export function executeReserve(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  paths: string[],
  reason?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const conflicts = store.getConflictsWithOtherAgents(paths[0] ?? '', state, dirs);
  if (conflicts.length > 0) {
    const conflictList = conflicts
      .map((c) => `  - ${c.agent}: ${c.pattern}${c.reason ? ` (${c.reason})` : ''}`)
      .join('\n');
    return result(`Cannot reserve: conflicting reservations found:\n${conflictList}`, {
      mode: 'reserve',
      error: 'conflict',
      conflicts,
    });
  }

  for (const pattern of paths) {
    state.reservations.push({
      pattern,
      reason,
      since: new Date().toISOString(),
    });
  }

  store.updateRegistration(state, dirs, ctx);

  const lines = ['Reserved paths:', ...paths.map((p) => `  - ${p}`)];
  if (reason) lines.push(`Reason: ${reason}`);

  return result(lines.join('\n'), { mode: 'reserve', paths, reason });
}

export function executeRelease(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  paths: string[] | true
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const released: string[] = [];
  const notFound: string[] = [];

  if (paths === true) {
    // Release all reservations
    released.push(...state.reservations.map((r) => r.pattern));
    state.reservations.length = 0;
  } else {
    for (const pattern of paths) {
      const idx = state.reservations.findIndex((r) => r.pattern === pattern);
      if (idx >= 0) {
        state.reservations.splice(idx, 1);
        released.push(pattern);
      } else {
        notFound.push(pattern);
      }
    }
  }

  store.updateRegistration(state, dirs, ctx);

  const lines: string[] = [];
  if (released.length > 0) {
    lines.push('Released paths:', ...released.map((p) => `  - ${p}`));
  }
  if (notFound.length > 0) {
    lines.push('Not found:', ...notFound.map((p) => `  - ${p}`));
  }

  return result(lines.join('\n'), { mode: 'release', released, notFound });
}

export function executeRename(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  _deliverMessage?: (msg: AgentMailMessage) => void,
  _updateStatus?: (ctx: ExtensionContext) => void
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const result_data = store.renameAgent(state, dirs, ctx, newName, () => {});

  if (result_data.success === false) {
    return result(`Error: ${result_data.error}`, { mode: 'rename', error: result_data.error });
  }

  store.updateRegistration(state, dirs, ctx);

  return result(`Renamed from ${result_data.oldName} to ${result_data.newName}`, {
    mode: 'rename',
    oldName: result_data.oldName,
    newName: result_data.newName,
  });
}

export function executeFeed(
  cwd: string,
  currentChannel: string,
  limit?: number,
  swarmEventsInFeed: boolean = true,
  requestedChannel?: string
) {
  const channelId = requestedChannel ? normalizeChannelId(requestedChannel) : currentChannel;
  const effectiveLimit = limit ?? 20;
  let events: FeedEvent[];
  if (!swarmEventsInFeed) {
    events = readFeedEvents(cwd, effectiveLimit * 2, channelId);
    events = events.filter((e) => !isSwarmEvent(e.type));
    events = events.slice(-effectiveLimit);
  } else {
    events = readFeedEvents(cwd, effectiveLimit, channelId);
  }

  if (events.length === 0) {
    return result(`# Activity Feed ${displayChannelLabel(channelId)}\n\nNo activity yet.`, {
      mode: 'feed',
      channel: channelId,
      events: [],
    });
  }

  const lines: string[] = [
    `# Activity Feed ${displayChannelLabel(channelId)} (last ${events.length})`,
    '',
  ];
  for (const event of events) {
    lines.push(formatFeedLine(event));
  }

  return result(lines.join('\n'), {
    mode: 'feed',
    channel: channelId,
    events: events.map((e) => ({ ...e, preview: e.preview ?? undefined })),
    count: events.length,
  });
}

export function executeSend(
  state: MessengerState,
  _dirs: Dirs,
  cwd: string,
  to: string | string[] | undefined,
  message?: string,
  _replyTo?: string,
  channel?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (!message) {
    return result('Error: message is required when sending.', {
      mode: 'send',
      error: 'missing_message',
    });
  }

  if (
    !to ||
    (Array.isArray(to) && to.length === 0) ||
    (typeof to === 'string' && to.trim().length === 0)
  ) {
    return result("Error: send requires 'to'. Use an agent name, agent list, or #channel.", {
      mode: 'send',
      error: 'missing_recipient',
    });
  }

  const isChannelTarget = typeof to === 'string' && to.startsWith('#');
  const targetChannel = isChannelTarget ? normalizeChannelId(to) : channel || state.currentChannel;

  // All messaging is now feed-based
  logFeedEvent(
    cwd,
    state.agentName,
    'message',
    typeof to === 'string' ? to : undefined,
    message,
    targetChannel
  );

  const targetLabel = typeof to === 'string' ? to : 'multiple recipients';
  const channelLabel = displayChannelLabel(targetChannel);
  // If the target is already a channel reference, just say "posted to #channel"
  const text = isChannelTarget
    ? `Message posted to ${targetLabel}.`
    : `Message posted to ${targetLabel} on ${channelLabel}.`;
  return result(text, {
    mode: 'send',
    channel: targetChannel,
    to: typeof to === 'string' ? to : undefined,
  });
}
