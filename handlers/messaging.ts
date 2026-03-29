import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentMailMessage, Dirs, MessengerState } from '../lib.js';
import { displayChannelLabel, normalizeChannelId } from '../channel.js';
import * as store from '../store.js';
import {
  formatFeedLine,
  isSwarmEvent,
  logFeedEvent,
  readFeedEvents,
  type FeedEvent,
} from '../feed.js';
import { notRegisteredError, result } from './result.js';

export function executeSend(
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  to: string | string[] | undefined,
  message?: string,
  replyTo?: string,
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

  const requestedChannel = channel ? normalizeChannelId(channel) : undefined;
  const isChannelPost = typeof to === 'string' && to.trim().startsWith('#');

  if (isChannelPost) {
    const targetChannel = normalizeChannelId(to);

    if (process.env.PI_SWARM_SPAWNED) {
      logFeedEvent(cwd, state.agentName, 'message', undefined, message, targetChannel);
      return result(`Message posted to ${displayChannelLabel(targetChannel)}.`, {
        mode: 'send',
        channel: targetChannel,
        sent: [],
        failed: [],
      });
    }

    const agents = store.getAgentsInChannel(state, dirs, targetChannel);
    const sent: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];

    for (const agent of agents) {
      try {
        store.sendMessageToAgent(state, dirs, agent.name, message, replyTo, targetChannel);
        sent.push(agent.name);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'write failed';
        failed.push({ name: agent.name, error: msg });
      }
    }

    logFeedEvent(cwd, state.agentName, 'message', undefined, message, targetChannel);

    let text =
      sent.length === 0
        ? `Message posted to ${displayChannelLabel(targetChannel)}.`
        : `Message posted to ${displayChannelLabel(targetChannel)} and delivered to ${sent.length} peer${sent.length === 1 ? '' : 's'}.`;
    if (failed.length > 0) {
      const failedStr = failed.map((f) => `${f.name} (${f.error})`).join(', ');
      text += ` Failed: ${failedStr}`;
    }

    return result(text, { mode: 'send', channel: targetChannel, sent, failed });
  }

  const recipients = [...new Set(Array.isArray(to) ? to : [to])];
  if (recipients.length === 0) {
    return result('Error: recipient list cannot be empty.', {
      mode: 'send',
      error: 'empty_recipients',
    });
  }

  const sent: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const recipient of recipients) {
    if (recipient === state.agentName) {
      failed.push({ name: recipient, error: 'cannot send to self' });
      continue;
    }

    const validation = store.validateTargetAgent(recipient, dirs);
    if (!validation.valid) {
      const errorMap: Record<string, string> = {
        invalid_name: 'invalid name',
        not_found: 'not found',
        not_active: 'no longer active',
        invalid_registration: 'invalid registration',
      };
      const errKey = (validation as { valid: false; error: string }).error;
      failed.push({ name: recipient, error: errorMap[errKey] });
      continue;
    }

    const messageChannel = store.resolveTargetChannel(dirs, recipient, requestedChannel);

    if (!messageChannel) {
      failed.push({
        name: recipient,
        error: requestedChannel
          ? `not joined to ${displayChannelLabel(requestedChannel)}`
          : 'no active channel',
      });
      continue;
    }

    try {
      store.sendMessageToAgent(state, dirs, recipient, message, replyTo, messageChannel);
      sent.push(recipient);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'write failed';
      failed.push({ name: recipient, error: msg });
    }
  }

  if (sent.length === 0) {
    const failedStr = failed.map((f) => `${f.name} (${f.error})`).join(', ');
    return result(`Failed to send: ${failedStr}`, {
      mode: 'send',
      error: 'all_failed',
      sent: [],
      failed,
    });
  }

  for (const name of sent) {
    const targetChannel =
      requestedChannel ?? store.resolveTargetChannel(dirs, name) ?? state.currentChannel;
    logFeedEvent(cwd, state.agentName, 'message', name, message, targetChannel);
  }

  let text = `Message sent to ${sent.join(', ')}.`;
  if (failed.length > 0) {
    const failedStr = failed.map((f) => `${f.name} (${f.error})`).join(', ');
    text += ` Failed: ${failedStr}`;
  }

  return result(text, {
    mode: 'send',
    channel: requestedChannel ?? state.currentChannel,
    sent,
    failed,
  });
}

export function executeReserve(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  patterns: string[],
  reason?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (patterns.length === 0) {
    return result('Error: at least one pattern required.', {
      mode: 'reserve',
      error: 'empty_patterns',
    });
  }

  const now = new Date().toISOString();

  for (const pattern of patterns) {
    state.reservations = state.reservations.filter((r) => r.pattern !== pattern);
    state.reservations.push({ pattern, reason, since: now });
  }

  store.updateRegistration(state, dirs, ctx);

  for (const pattern of patterns) {
    logFeedEvent(
      ctx.cwd ?? process.cwd(),
      state.agentName,
      'reserve',
      pattern,
      reason,
      state.currentChannel
    );
  }

  return result(`Reserved: ${patterns.join(', ')}`, { mode: 'reserve', patterns, reason });
}

export function executeRelease(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  release: string[] | true
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (release === true) {
    const released = state.reservations.map((r) => r.pattern);
    state.reservations = [];
    store.updateRegistration(state, dirs, ctx);
    for (const pattern of released) {
      logFeedEvent(
        ctx.cwd ?? process.cwd(),
        state.agentName,
        'release',
        pattern,
        undefined,
        state.currentChannel
      );
    }
    return result(
      released.length > 0 ? `Released all: ${released.join(', ')}` : 'No reservations to release.',
      {
        mode: 'release',
        released,
      }
    );
  }

  const patterns = release;
  const releasedPatterns = state.reservations
    .filter((r) => patterns.includes(r.pattern))
    .map((r) => r.pattern);
  state.reservations = state.reservations.filter((r) => !patterns.includes(r.pattern));

  store.updateRegistration(state, dirs, ctx);
  for (const pattern of releasedPatterns) {
    logFeedEvent(
      ctx.cwd ?? process.cwd(),
      state.agentName,
      'release',
      pattern,
      undefined,
      state.currentChannel
    );
  }

  return result(`Released ${releasedPatterns.length} reservation(s).`, {
    mode: 'release',
    released: releasedPatterns,
  });
}

export function executeRename(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void,
  updateStatusFn: (ctx: ExtensionContext) => void
) {
  store.stopWatcher(state);

  const renameResult = store.renameAgent(state, dirs, ctx, newName, deliverFn);

  if (!renameResult.success) {
    store.startWatcher(state, dirs, deliverFn);

    const errCode = (renameResult as { success: false; error: string }).error;
    const errorMessages: Record<string, string> = {
      not_registered: 'Cannot rename - not registered.',
      invalid_name: `Invalid name "${newName}" - use only letters, numbers, underscore, hyphen.`,
      name_taken: `Name "${newName}" is already in use by another agent.`,
      same_name: `Already named "${newName}".`,
      race_lost: `Name "${newName}" was claimed by another agent.`,
    };
    return result(`Error: ${errorMessages[errCode]}`, { mode: 'rename', error: errCode });
  }

  state.watcherRetries = 0;
  store.startWatcher(state, dirs, deliverFn);
  updateStatusFn(ctx);

  return result(`Renamed from "${renameResult.oldName}" to "${renameResult.newName}".`, {
    mode: 'rename',
    oldName: renameResult.oldName,
    newName: renameResult.newName,
  });
}

export function executeSetStatus(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  message?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  if (!message || message.trim() === '') {
    state.statusMessage = undefined;
    state.customStatus = false;
    store.updateRegistration(state, dirs, ctx);
    return result('Custom status cleared. Auto-status will resume.', {
      mode: 'set_status',
      cleared: true,
    });
  }

  state.statusMessage = message.trim();
  state.customStatus = true;
  store.updateRegistration(state, dirs, ctx);
  return result(`Status set to: ${state.statusMessage}`, {
    mode: 'set_status',
    message: state.statusMessage,
  });
}

export function executeFeed(
  cwd: string,
  currentChannel: string,
  limit?: number,
  swarmEventsInFeed: boolean = true,
  requestedChannel?: string
) {
  const channelId = normalizeChannelId(requestedChannel ?? currentChannel);
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

  return result(lines.join('\n'), { mode: 'feed', channel: channelId, events });
}
