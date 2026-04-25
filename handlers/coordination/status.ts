import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { Dirs, MessengerState } from '../../lib.js';
import { extractFolder, truncatePathLeft } from '../../lib.js';
import { displayChannelLabel } from '../../channel.js';
import * as store from '../../store.js';
import * as taskStore from '../../swarm/task-store.js';
import { getEffectiveSessionId } from '../../store/shared.js';
import { notRegisteredError, result } from '../result.js';

export function executeStatus(state: MessengerState, dirs: Dirs, cwd: string = process.cwd()) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const agents = store.getActiveAgents(state, dirs);
  const folder = extractFolder(cwd);
  const location = state.gitBranch ? `${folder} (${state.gitBranch})` : folder;
  const sessionId = getEffectiveSessionId(cwd, state);
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
  text += '\nUse `pi-messenger-swarm list` for details, `pi-messenger-swarm task list` for tasks.';

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
