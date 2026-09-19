import type { Dirs, MessengerState } from '../../lib.js';
import {
  ACTIVE_THRESHOLD_MS,
  displayChannelLabel,
  getLastActivity,
  listChannels,
  type ChannelRecord,
} from '../../channel.js';
import * as store from '../../store.js';
import { notRegisteredError, result } from '../result.js';

function formatRelativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `${hours}h ${rem}m ago` : `${hours}h ago`;
}

function formatChannelLine(
  channel: ChannelRecord,
  dirs: Dirs,
  state: MessengerState,
  now: number
): { line: string; active: boolean } {
  const label = displayChannelLabel(channel.id);
  const type = channel.type;

  // #memory is always active (cross-session by design)
  if (channel.type === 'named' && channel.id === 'memory') {
    return {
      line: `  ${label.padEnd(24)} named    persistent`,
      active: true,
    };
  }

  // Named channels: check staleness based on last activity
  if (channel.type === 'named') {
    const lastTs = getLastActivity(dirs, channel.id);
    const referenceTs = lastTs ?? channel.createdAt;
    const isActive = now - new Date(referenceTs).getTime() < ACTIVE_THRESHOLD_MS;

    if (isActive) {
      const note = channel.description || '';
      return {
        line: `  ${label.padEnd(24)} named    ${note}`,
        active: true,
      };
    }

    // Stale named channel
    const note = lastTs ? `last activity ${formatRelativeTime(lastTs)}` : 'no activity';
    return {
      line: `  ${label.padEnd(24)} named    ${note}`,
      active: false,
    };
  }

  // Session: check for agents
  const agents = store.getAgentsInChannel(state, dirs, channel.id);
  if (agents.length > 0) {
    const names = agents.map((a) => a.name).join(', ');
    const count = `${agents.length} agent${agents.length > 1 ? 's' : ''}`;
    return {
      line: `  ${label.padEnd(24)} session  ${count} · ${names}`,
      active: true,
    };
  }

  // Session: check last feed activity
  const lastTs = getLastActivity(dirs, channel.id);
  if (lastTs) {
    const eventTime = new Date(lastTs).getTime();
    if (now - eventTime < ACTIVE_THRESHOLD_MS) {
      return {
        line: `  ${label.padEnd(24)} session  idle · last activity ${formatRelativeTime(lastTs)}`,
        active: true,
      };
    }
  }

  // Not active
  const note = lastTs ? `last activity ${formatRelativeTime(lastTs)}` : 'no activity';
  return {
    line: `  ${label.padEnd(24)} session  ${note}`,
    active: false,
  };
}

export function executeChannels(
  state: MessengerState,
  dirs: Dirs,
  _cwd: string,
  showAll?: boolean
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const now = Date.now();
  const channels = listChannels(dirs);

  if (channels.length === 0) {
    return result('No channels found.', {
      mode: 'channels',
      channels: [],
    });
  }

  const lines: string[] = [];
  const activeLines: string[] = [];
  const inactiveLines: string[] = [];

  for (const channel of channels) {
    const { line, active } = formatChannelLine(channel, dirs, state, now);
    if (active) {
      activeLines.push(line);
    } else {
      inactiveLines.push(line);
    }
  }

  if (activeLines.length > 0) {
    lines.push('# Active Channels');
    lines.push('');
    lines.push(`  ${'Channel'.padEnd(24)} Type     Status`);
    lines.push(`  ${'─'.repeat(24)} ──────── ──────────────────`);
    lines.push('');
    lines.push(...activeLines);
    lines.push('');
  }

  if (showAll && inactiveLines.length > 0) {
    lines.push('# Inactive Channels');
    lines.push('');
    lines.push(...inactiveLines);
    lines.push('');
  } else if (inactiveLines.length > 0) {
    const n = inactiveLines.length;
    lines.push(`${n} inactive channel${n > 1 ? 's' : ''} not shown. Use --all to list.`);
    lines.push('');
  }

  if (activeLines.length === 0 && !showAll) {
    lines.push('No active channels found. Use --all to list all channels.');
  }

  return result(lines.join('\n').trim(), {
    mode: 'channels',
    active: activeLines.length,
    inactive: inactiveLines.length,
    total: channels.length,
  });
}
