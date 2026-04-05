import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import { isProcessAlive } from '../lib.js';
import {
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

/**
 * Read a channel's sessionId from the project-scoped location.
 * Returns null if channel doesn't exist or has no sessionId.
 */
export function getProjectChannelSessionId(cwd: string, channelId: string): string | null {
  const normalized = normalizeChannelId(channelId);
  const channelPath = join(cwd, '.pi', 'messenger', 'channels', `${normalized}.jsonl`);
  try {
    if (!fs.existsSync(channelPath)) return null;
    const content = fs.readFileSync(channelPath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0) return null;
    const header = JSON.parse(lines[0]) as { _meta?: boolean; sessionId?: string };
    if (header._meta && header.sessionId) {
      return header.sessionId;
    }
  } catch {
    // Fall through
  }
  return null;
}

/**
 * Get the effective session ID for swarm operations.
 * Uses the current channel's stored sessionId if available,
 * otherwise falls back to the current pi context session.
 * This ensures all operations in a channel use consistent storage,
 * regardless of which pi process (parent or subagent) performs them.
 */
export function getEffectiveSessionId(cwd: string, state: MessengerState): string {
  const currentChannel = state.currentChannel ?? state.sessionChannel;
  if (currentChannel) {
    const channelSessionId = getProjectChannelSessionId(cwd, currentChannel);
    if (channelSessionId) {
      return channelSessionId;
    }
  }
  return state.contextSessionId ?? '';
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
