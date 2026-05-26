import type { Dirs, MessengerState } from '../lib.js';
import { normalizeChannelId, isValidChannelId } from '../channel.js';
import { logFeedEvent } from '../feed/index.js';
import { getActiveAgents, getAgentPreferredChannel } from '../store/agents.js';

export type InputHandlerResult = { action: 'continue' } | { action: 'handled' };

/**
 * Handle `#channel message` or `#all message` input from the human user.
 *
 * Returns `{ action: "handled" }` when the input is consumed (so the LLM
 * is NOT invoked), or `{ action: "continue" }` to let it pass through.
 */
export function handleHashInput(
  text: string,
  state: MessengerState,
  dirs: Dirs,
  cwd: string,
  notify: (msg: string, kind?: 'info' | 'warning' | 'error') => void
): InputHandlerResult {
  // Must be registered and text must start with `#` followed by non-space chars and a space
  if (!state.registered) return { action: 'continue' };
  if (!text.startsWith('#')) return { action: 'continue' };

  const firstSpace = text.indexOf(' ');
  if (firstSpace <= 1) return { action: 'continue' }; // bare `#` or `# ` with nothing after

  const channelPart = text.slice(1, firstSpace).trim(); // e.g. "all" or "memory"
  const message = text.slice(firstSpace + 1).trim();

  if (!channelPart || !message) return { action: 'continue' };

  if (channelPart === 'all') {
    // Broadcast: log to every active agent's preferred channel + current channel
    const agents = getActiveAgents(state, dirs);
    const channels = new Set<string>();
    channels.add(state.currentChannel);
    for (const agent of agents) {
      channels.add(getAgentPreferredChannel(agent));
    }
    for (const channel of channels) {
      logFeedEvent(cwd, state.agentName, 'message', '#all', message, channel);
    }
    const count = agents.length;
    notify(
      count > 0
        ? `Broadcast sent to ${count} agent${count === 1 ? '' : 's'}`
        : 'Broadcast posted (no active agents)',
      'info'
    );
    return { action: 'handled' };
  }

  // Specific named channel: #memory, #general, etc.
  const channelId = normalizeChannelId(`#${channelPart}`);
  if (!isValidChannelId(channelId)) return { action: 'continue' };

  logFeedEvent(cwd, state.agentName, 'message', undefined, message, channelId);
  notify(`Sent to #${channelId}`, 'info');
  return { action: 'handled' };
}
