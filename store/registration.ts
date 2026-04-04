import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type {
  AgentMailMessage,
  AgentRegistration,
  Dirs,
  MessengerState,
  NameThemeConfig,
} from '../lib.js';
import { generateMemorableName, isProcessAlive, isValidAgentName } from '../lib.js';
import {
  ensureExistingOrCreateChannel,
  getChannel,
  isValidChannelId,
  normalizeChannelId,
} from '../channel.js';
import { findAvailableName, invalidateAgentsCache } from './agents.js';
import {
  applyRegistrationDefaults,
  ensureDirSync,
  ensureStateChannels,
  getContextSessionId,
  getGitBranch,
  normalizeCwd,
  updateChannelsInRegistration,
} from './shared.js';

export function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

export function register(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  nameTheme?: NameThemeConfig
): boolean {
  if (state.registered) return true;

  ensureDirSync(dirs.registry);

  if (!state.agentName) {
    state.agentName = generateMemorableName(nameTheme);
  }

  ensureStateChannels(state, dirs, ctx);
  state.contextSessionId = getContextSessionId(ctx);

  const isExplicitName = !!process.env.PI_AGENT_NAME;
  const maxAttempts = isExplicitName ? 1 : 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isExplicitName) {
      if (!isValidAgentName(state.agentName)) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`,
            'error'
          );
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Agent name "${state.agentName}" already in use (PID ${existing.pid})`,
                'error'
              );
            }
            return false;
          }
        } catch {
          // Malformed, proceed to overwrite
        }
      }
    } else {
      const availableName = findAvailableName(state.agentName, dirs);
      if (!availableName) {
        if (ctx.hasUI) {
          ctx.ui.notify('Could not find available agent name after 99 attempts', 'error');
        }
        return false;
      }
      state.agentName = availableName;
    }

    const regPath = getRegistrationPath(state, dirs);
    if (fs.existsSync(regPath)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore
      }
    }

    const cwd = normalizeCwd(process.cwd());
    const gitBranch = getGitBranch(cwd);
    const now = new Date().toISOString();
    const registration: AgentRegistration = {
      name: state.agentName,
      pid: process.pid,
      sessionId: getContextSessionId(ctx),
      cwd,
      model:
        (ctx.model as { id?: string } | undefined)?.id ??
        (typeof ctx.model === 'string' ? ctx.model : 'unknown'),
      startedAt: now,
      gitBranch,
      spec: state.spec,
      isHuman: state.isHuman,
      session: { ...state.session },
      activity: { lastActivityAt: now },
      currentChannel: state.currentChannel,
      sessionChannel: state.sessionChannel,
      joinedChannels: [...state.joinedChannels],
    };

    try {
      fs.writeFileSync(regPath, JSON.stringify(registration, null, 2));
    } catch (err) {
      if (ctx.hasUI) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        ctx.ui.notify(`Failed to register: ${msg}`, 'error');
      }
      return false;
    }

    let verified = false;
    let verifyError = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
      verified = written.pid === process.pid;
    } catch {
      verifyError = true;
    }

    if (verified) {
      state.registered = true;
      state.model =
        (ctx.model as { id?: string } | undefined)?.id ??
        (typeof ctx.model === 'string' ? ctx.model : 'unknown');
      state.gitBranch = gitBranch;
      state.activity.lastActivityAt = now;
      invalidateAgentsCache();
      return true;
    }

    if (verifyError) {
      try {
        const checkContent = fs.readFileSync(regPath, 'utf-8');
        const checkReg: AgentRegistration = JSON.parse(checkContent);
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(regPath);
        }
      } catch {
        // Best effort cleanup
      }
    }

    if (isExplicitName) {
      if (ctx.hasUI) {
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, 'error');
      }
      return false;
    }
    invalidateAgentsCache();
  }

  if (ctx.hasUI) {
    ctx.ui.notify('Failed to register after multiple attempts due to name conflicts', 'error');
  }
  return false;
}

export function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg = applyRegistrationDefaults(
      JSON.parse(fs.readFileSync(regPath, 'utf-8')) as AgentRegistration
    );
    const currentModel =
      (ctx.model as { id?: string } | undefined)?.id ??
      (typeof ctx.model === 'string' ? ctx.model : reg.model);
    const currentSessionId = getContextSessionId(ctx);
    reg.model = currentModel;
    reg.sessionId = currentSessionId;
    state.model = currentModel;
    state.contextSessionId = currentSessionId;
    reg.reservations = state.reservations.length > 0 ? state.reservations : undefined;
    if (state.spec) {
      reg.spec = state.spec;
    } else {
      delete reg.spec;
    }
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    fs.writeFileSync(regPath, JSON.stringify(updateChannelsInRegistration(state, reg), null, 2));
  } catch {
    // Ignore errors
  }
}

export function flushActivityToRegistry(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext
): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg = applyRegistrationDefaults(
      JSON.parse(fs.readFileSync(regPath, 'utf-8')) as AgentRegistration
    );
    const currentModel =
      (ctx.model as { id?: string } | undefined)?.id ??
      (typeof ctx.model === 'string' ? ctx.model : reg.model);
    const currentSessionId = getContextSessionId(ctx);
    reg.model = currentModel;
    reg.sessionId = currentSessionId;
    state.model = currentModel;
    state.contextSessionId = currentSessionId;
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    reg.statusMessage = state.statusMessage;
    fs.writeFileSync(regPath, JSON.stringify(updateChannelsInRegistration(state, reg), null, 2));
  } catch {
    // Ignore errors
  }
}

export function syncChannelsToRegistration(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;
  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg = applyRegistrationDefaults(
      JSON.parse(fs.readFileSync(regPath, 'utf-8')) as AgentRegistration
    );
    fs.writeFileSync(regPath, JSON.stringify(updateChannelsInRegistration(state, reg), null, 2));
  } catch {
    // Ignore errors
  }
}

export function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered) return;

  try {
    fs.unlinkSync(getRegistrationPath(state, dirs));
  } catch {
    // Ignore errors
  }
  state.registered = false;
  invalidateAgentsCache();
}

export interface RebindContextSessionResult {
  changed: boolean;
  previousCurrentChannel: string;
  previousSessionChannel: string;
  previousContextSessionId?: string;
  currentContextSessionId: string;
}

export function rebindContextSession(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext
): RebindContextSessionResult {
  const currentContextSessionId = getContextSessionId(ctx);
  const previousContextSessionId = state.contextSessionId;
  const previousCurrentChannel = state.currentChannel;
  const previousSessionChannel = state.sessionChannel;
  const previousJoinedChannels = JSON.stringify(state.joinedChannels);

  const inheritedChannel = process.env.PI_MESSENGER_CHANNEL?.trim();
  const shouldRebind =
    !!inheritedChannel ||
    (!!currentContextSessionId && currentContextSessionId !== previousContextSessionId);

  if (!shouldRebind) {
    return {
      changed: false,
      previousCurrentChannel,
      previousSessionChannel,
      previousContextSessionId,
      currentContextSessionId,
    };
  }

  ensureStateChannels(state, dirs, ctx);
  state.contextSessionId = currentContextSessionId;

  const changed =
    previousCurrentChannel !== state.currentChannel ||
    previousSessionChannel !== state.sessionChannel ||
    previousContextSessionId !== currentContextSessionId ||
    previousJoinedChannels !== JSON.stringify(state.joinedChannels);

  if (changed && state.registered) {
    updateRegistration(state, dirs, ctx);
  }

  return {
    changed,
    previousCurrentChannel,
    previousSessionChannel,
    previousContextSessionId,
    currentContextSessionId,
  };
}

export type RenameResult =
  | { success: true; oldName: string; newName: string }
  | {
      success: false;
      error: 'not_registered' | 'invalid_name' | 'name_taken' | 'same_name' | 'race_lost';
    };

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered) {
    return { success: false, error: 'not_registered' };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: 'invalid_name' };
  }

  if (newName === state.agentName) {
    return { success: false, error: 'same_name' };
  }

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, 'utf-8'));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: 'name_taken' };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);

  const cwd = normalizeCwd(process.cwd());
  const gitBranch = getGitBranch(cwd);
  const now = new Date().toISOString();
  const registration: AgentRegistration = {
    name: newName,
    pid: process.pid,
    sessionId: getContextSessionId(ctx),
    cwd,
    model:
      (ctx.model as { id?: string } | undefined)?.id ??
      (typeof ctx.model === 'string' ? ctx.model : 'unknown'),
    startedAt: now,
    reservations: state.reservations.length > 0 ? state.reservations : undefined,
    gitBranch,
    spec: state.spec,
    isHuman: state.isHuman,
    session: { ...state.session },
    activity: { lastActivityAt: now },
    statusMessage: state.statusMessage,
    currentChannel: state.currentChannel,
    sessionChannel: state.sessionChannel,
    joinedChannels: [...state.joinedChannels],
  };

  ensureDirSync(dirs.registry);

  try {
    fs.writeFileSync(join(dirs.registry, `${newName}.json`), JSON.stringify(registration, null, 2));
  } catch {
    return { success: false, error: 'invalid_name' as const };
  }

  let verified = false;
  let verifyError = false;
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, 'utf-8'));
    verified = written.pid === process.pid;
  } catch {
    verifyError = true;
  }

  if (!verified) {
    if (verifyError) {
      try {
        const checkReg: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, 'utf-8'));
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(newRegPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
    return { success: false, error: 'race_lost' };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;

  state.model =
    (ctx.model as { id?: string } | undefined)?.id ??
    (typeof ctx.model === 'string' ? ctx.model : 'unknown');
  state.gitBranch = gitBranch;
  state.sessionStartedAt = now;
  state.activity.lastActivityAt = now;
  invalidateAgentsCache();
  return { success: true, oldName, newName };
}

export type JoinChannelResult =
  | { success: true; channel: string; created: boolean; switched: boolean; alreadyJoined: boolean }
  | { success: false; error: 'invalid_channel' | 'not_found' };

export function joinChannel(
  state: MessengerState,
  dirs: Dirs,
  channelId: string,
  options?: { create?: boolean; description?: string }
): JoinChannelResult {
  if (!isValidChannelId(channelId)) {
    return { success: false, error: 'invalid_channel' };
  }

  const normalizedRequested = normalizeChannelId(channelId);
  const existedBefore = !!getChannel(dirs, normalizedRequested);
  const record = ensureExistingOrCreateChannel(dirs, channelId, {
    create: options?.create,
    createdBy: state.agentName || undefined,
    description: options?.description,
  });
  if (!record) {
    return { success: false, error: 'not_found' };
  }

  const normalized = normalizeChannelId(record.id);
  const wasCurrent = state.currentChannel === normalized;
  const alreadyJoined = state.joinedChannels.includes(normalized);
  if (!alreadyJoined) {
    state.joinedChannels = [...state.joinedChannels, normalized];
  }
  state.currentChannel = normalized;
  syncChannelsToRegistration(state, dirs);

  return {
    success: true,
    channel: normalized,
    created: !existedBefore,
    switched: !wasCurrent,
    alreadyJoined,
  };
}
