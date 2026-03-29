import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import { isProcessAlive } from '../lib.js';
import {
  HEARTBEAT_CHANNEL_ID,
  MEMORY_CHANNEL_ID,
  ensureDefaultNamedChannels,
  ensureExistingOrCreateChannel,
  ensureSessionChannel,
  getChannel,
  normalizeChannelId,
} from '../channel.js';

export function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

export function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync('git branch --show-current', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (result) return result;

    const sha = execSync('git rev-parse --short HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeJoinedChannels(
  channels: string[] | undefined,
  currentChannel?: string,
  sessionChannel?: string
): string[] {
  const set = new Set<string>();
  for (const channel of channels ?? []) {
    if (channel) set.add(normalizeChannelId(channel));
  }
  if (sessionChannel) set.add(normalizeChannelId(sessionChannel));
  if (currentChannel) set.add(normalizeChannelId(currentChannel));
  set.add(MEMORY_CHANNEL_ID);
  set.add(HEARTBEAT_CHANNEL_ID);
  return Array.from(set);
}

export function keepNamedChannels(dirs: Dirs, channels: string[] | undefined): string[] {
  const kept = new Set<string>();
  for (const channel of channels ?? []) {
    if (!channel) continue;
    const normalized = normalizeChannelId(channel);
    const record = getChannel(dirs, normalized);
    if (record?.type === 'session') continue;
    kept.add(normalized);
  }
  return Array.from(kept);
}

export function getContextSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId?.() ?? '';
  } catch {
    return '';
  }
}

export function ensureStateChannels(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext
): void {
  ensureDefaultNamedChannels(dirs, state.agentName || undefined);

  const inheritedChannel = process.env.PI_MESSENGER_CHANNEL?.trim();
  const sessionId = getContextSessionId(ctx);

  let sessionChannel = state.sessionChannel?.trim();
  let resetToSessionChannel = false;
  if (inheritedChannel) {
    const record = ensureExistingOrCreateChannel(dirs, inheritedChannel, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    sessionChannel = record?.id ?? normalizeChannelId(inheritedChannel);
    resetToSessionChannel = true;
  } else if (sessionId) {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  } else if (sessionChannel) {
    const record = ensureExistingOrCreateChannel(dirs, sessionChannel, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    sessionChannel = record?.id ?? normalizeChannelId(sessionChannel);
  } else {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  }

  state.sessionChannel = normalizeChannelId(sessionChannel);

  if (resetToSessionChannel) {
    state.currentChannel = state.sessionChannel;
    state.joinedChannels = normalizeJoinedChannels(
      keepNamedChannels(dirs, state.joinedChannels),
      state.sessionChannel,
      state.sessionChannel
    );
    return;
  }

  let currentChannel = state.currentChannel?.trim();
  if (currentChannel) {
    const record = ensureExistingOrCreateChannel(dirs, currentChannel, {
      create: true,
      createdBy: state.agentName || undefined,
    });
    currentChannel = record?.id ?? normalizeChannelId(currentChannel);
  } else {
    currentChannel = state.sessionChannel;
  }

  state.currentChannel = normalizeChannelId(currentChannel);
  state.joinedChannels = normalizeJoinedChannels(
    state.joinedChannels,
    state.currentChannel,
    state.sessionChannel
  );
}

export function applyRegistrationDefaults(reg: AgentRegistration): AgentRegistration {
  const currentChannel = reg.currentChannel ? normalizeChannelId(reg.currentChannel) : undefined;
  const sessionChannel = reg.sessionChannel
    ? normalizeChannelId(reg.sessionChannel)
    : currentChannel;
  return {
    ...reg,
    session: reg.session ?? { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: reg.activity ?? { lastActivityAt: reg.startedAt },
    isHuman: reg.isHuman ?? false,
    currentChannel: currentChannel ?? sessionChannel ?? undefined,
    sessionChannel,
    joinedChannels: normalizeJoinedChannels(reg.joinedChannels, currentChannel, sessionChannel),
  };
}

export function updateChannelsInRegistration(
  state: MessengerState,
  reg: AgentRegistration
): AgentRegistration {
  return {
    ...reg,
    currentChannel: state.currentChannel,
    sessionChannel: state.sessionChannel,
    joinedChannels: normalizeJoinedChannels(
      state.joinedChannels,
      state.currentChannel,
      state.sessionChannel
    ),
  };
}

const LOCK_STALE_MS = 10000;

export async function withSwarmLock<T>(baseDir: string, fn: () => T): Promise<T> {
  const lockPath = join(baseDir, 'swarm.lock');
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
          if (!pid || !isProcessAlive(pid)) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Lock doesn't exist
    }

    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (i === maxRetries - 1) {
          throw new Error('Failed to acquire swarm lock');
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err;
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }
}

export function getMyInboxRoot(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.agentName);
}

export function getMyInbox(
  state: MessengerState,
  dirs: Dirs,
  channelId: string = state.currentChannel
): string {
  return join(getMyInboxRoot(state, dirs), normalizeChannelId(channelId));
}
