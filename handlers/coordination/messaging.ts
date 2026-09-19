import type { Dirs, MessengerState } from '../../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../../channel.js';
import { findSpawnedAgentByName } from '../../swarm/spawn.js';
import { getEffectiveSessionId } from '../../store/shared.js';
import {
  formatFeedLine,
  isSwarmEvent,
  logFeedEvent,
  readFeedEvents,
  type FeedEvent,
} from '../../feed/index.js';
import { notRegisteredError, result } from '../result.js';

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

  // Check if targeting a completed/failed/stopped spawned agent
  let spawnWarning = '';
  if (typeof to === 'string' && !isChannelTarget) {
    const sessionId = getEffectiveSessionId(cwd, state);
    const spawnedAgent = findSpawnedAgentByName(cwd, sessionId, to);
    if (spawnedAgent && spawnedAgent.status !== 'running') {
      const statusEmoji =
        spawnedAgent.status === 'completed' ? '✅' : spawnedAgent.status === 'failed' ? '❌' : '🛑';
      spawnWarning = `\n\n⚠️ Warning: ${to} is a spawned agent that has already ${spawnedAgent.status} ${statusEmoji}. The message will be logged to the feed, but the agent process is no longer active.`;
      if (spawnedAgent.status === 'completed') {
        spawnWarning += `\n   If you need to continue the work, consider spawning a new agent.`;
      } else if (spawnedAgent.status === 'failed') {
        spawnWarning += `\n   The agent failed with errors. Review the task and consider respawning.`;
      }
    }
  }

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
  let text = isChannelTarget
    ? `Message posted to ${targetLabel}.`
    : `Message posted to ${targetLabel} on ${channelLabel}.`;

  // Append warning if targeting a completed/failed/stopped agent
  text += spawnWarning;

  return result(text, {
    mode: 'send',
    channel: targetChannel,
    to: typeof to === 'string' ? to : undefined,
    warning: spawnWarning ? 'target_agent_completed' : undefined,
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
