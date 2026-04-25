import { existsSync } from 'node:fs';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentMailMessage, Dirs, MessengerState, NameThemeConfig } from '../../lib.js';
import { displaySpecPath, extractFolder, resolveSpecPath } from '../../lib.js';
import { displayChannelLabel } from '../../channel.js';
import * as store from '../../store.js';
import { logFeedEvent, pruneFeed } from '../../feed/index.js';
import { result } from '../result.js';

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
      '\n\nUse `pi-messenger-swarm list` for details, `pi-messenger-swarm task list` for tasks.';
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
