import * as fs from 'node:fs';
import { atomicWriteFileSync } from '../persistence.js';
import { join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type {
  AgentMailMessage,
  AgentRegistration,
  FileReservation,
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
  applyRoutingFromRegistration,
  registrationMatchesState,
  ensureDirSync,
  ensureStateChannels,
  getContextSessionId,
  getGitBranch,
  normalizeCwd,
  normalizeJoinedChannels,
  updateChannelsInRegistration,
  readRegistrationSync,
  withRegistryLock,
} from './shared.js';

// Callback reads and changes only the fields owned by this operation, under
// the same lock as name allocation, rename, unregister and stale cleanup.
export function mutateOwnedRegistration<T>(
  state: MessengerState,
  dirs: Dirs,
  mutate: (reg: AgentRegistration) => T
): T | undefined {
  if (!state.registered || !isValidAgentName(state.agentName)) return;
  try {
    return withRegistryLock(dirs, () => {
      const path = getRegistrationPath(state, dirs);
      const reg = readRegistrationSync(path);
      if (!reg || !registrationMatchesState(reg, state)) return;
      const before = JSON.stringify(reg, null, 2);
      const result = mutate(reg);
      const after = JSON.stringify(reg, null, 2);
      if (after !== before) {
        atomicWriteFileSync(path, after);
        invalidateAgentsCache();
      }
      return result;
    });
  } catch {
    // Best effort: malformed or replacement records remain untouched.
  }
}

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
  try {
    ensureDirSync(dirs.registry);
    return withRegistryLock(dirs, () => {
      const pid = state.callerPid ?? process.pid;
      if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff)
        throw new Error(`Invalid PID: ${pid}`);
      const name =
        state.agentName || findAvailableName(generateMemorableName(nameTheme), dirs, pid);
      if (!name || !isValidAgentName(name))
        throw new Error(`Invalid or unavailable agent name: ${name}`);
      const path = join(dirs.registry, `${name}.json`);
      const existing = readRegistrationSync(path);
      if (existing && existing.pid !== pid && isProcessAlive(existing.pid)) {
        throw new Error(`Agent name "${name}" already in use (PID ${existing.pid})`);
      }
      state.agentName = name;
      const sessionId = getContextSessionId(ctx);
      const sameSession = existing?.sessionId === sessionId && !!existing;
      if (sameSession) {
        if (existing.currentChannel)
          state.currentChannel = normalizeChannelId(existing.currentChannel);
        if (existing.joinedChannels)
          state.joinedChannels = normalizeJoinedChannels(existing.joinedChannels);
      }
      ensureStateChannels(state, dirs, ctx, { preserveNamedChannel: sameSession });
      const cwd = normalizeCwd(ctx.cwd ?? process.cwd());
      const gitBranch = getGitBranch(cwd);
      const startedAt = new Date().toISOString();
      const model = getModel(ctx, 'unknown');
      const registration: AgentRegistration = {
        ...(sameSession && existing.pid === pid ? existing : {}),
        name,
        pid,
        sessionId,
        cwd,
        model,
        startedAt,
        gitBranch,
        spec: state.spec,
        isHuman: state.isHuman,
        session: { ...state.session },
        activity: { lastActivityAt: startedAt },
      };
      updateChannelsInRegistration(state, registration);
      atomicWriteFileSync(path, JSON.stringify(registration, null, 2));
      state.registered = true;
      state.registrationStartedAt = startedAt;
      state.contextSessionId = sessionId;
      state.model = model;
      state.gitBranch = gitBranch;
      state.activity.lastActivityAt = startedAt;
      invalidateAgentsCache();
      return true;
    });
  } catch (error) {
    if (ctx.hasUI) ctx.ui.notify(`Failed to register: ${String(error)}`, 'error');
    return false;
  }
}

function getModel(ctx: ExtensionContext, fallback: string): string {
  return (
    (ctx.model as { id?: string } | undefined)?.id ??
    (typeof ctx.model === 'string' ? ctx.model : fallback)
  );
}

export function flushActivityToRegistry(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext
): void {
  mutateOwnedRegistration(state, dirs, (reg) => {
    state.model = reg.model = getModel(ctx, reg.model);
    // A periodic flush never republishes stale routing or session identity.
    reg.session = { ...state.session };
    reg.activity = { ...state.activity };
    if (reg.customStatus) {
      state.customStatus = true;
      state.statusMessage = reg.statusMessage;
    } else {
      reg.statusMessage = state.statusMessage;
    }
  });
}

export function patchRegistrationSessionId(
  state: MessengerState,
  dirs: Dirs,
  sessionId: string
): boolean {
  if (!sessionId) return false;
  return (
    mutateOwnedRegistration(state, dirs, (reg) => {
      if (!reg.sessionId) reg.sessionId = sessionId;
      return true;
    }) ?? false
  );
}

export function mutateReservations<T>(
  state: MessengerState,
  dirs: Dirs,
  edit: (reservations: FileReservation[]) => T
): T | undefined {
  return mutateOwnedRegistration(state, dirs, (reg) => {
    const reservations = [...(reg.reservations ?? [])];
    const result = edit(reservations);
    reg.reservations = reservations.length > 0 ? reservations : undefined;
    state.reservations = reservations;
    return result;
  });
}

export function unregister(state: MessengerState, dirs: Dirs): void {
  if (!state.registered || !isValidAgentName(state.agentName)) return;
  try {
    withRegistryLock(dirs, () => {
      const path = getRegistrationPath(state, dirs);
      const reg = readRegistrationSync(path);
      if (reg && registrationMatchesState(reg, state)) fs.unlinkSync(path);
    });
  } catch {
    // Best effort; preserve malformed records and replacement owners.
  }
  state.registered = false;
  state.registrationStartedAt = undefined;
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
    (!!inheritedChannel && !state.sessionChannel) ||
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

  rebindRegisteredChannels(state, dirs, ctx);
  const changed =
    previousCurrentChannel !== state.currentChannel ||
    previousSessionChannel !== state.sessionChannel ||
    previousContextSessionId !== state.contextSessionId ||
    previousJoinedChannels !== JSON.stringify(state.joinedChannels);

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

// The already-joined path may need to establish a session channel even
// when rebindContextSession's local session ID did not change.
export function rebindRegisteredChannels(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext
): void {
  const rebind = () => {
    ensureStateChannels(state, dirs, ctx);
    state.contextSessionId = getContextSessionId(ctx);
  };
  if (!state.registered) {
    rebind();
    return;
  }
  mutateOwnedRegistration(state, dirs, (reg) => {
    applyRoutingFromRegistration(state, reg);
    rebind();
    if (state.contextSessionId) reg.sessionId = state.contextSessionId;
    updateChannelsInRegistration(state, reg);
  });
}

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  _deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered || !isValidAgentName(state.agentName))
    return { success: false, error: 'not_registered' };
  if (!isValidAgentName(newName)) return { success: false, error: 'invalid_name' };
  if (newName === state.agentName) return { success: false, error: 'same_name' };

  try {
    return withRegistryLock(dirs, () => {
      const oldName = state.agentName;
      const oldPath = getRegistrationPath(state, dirs);
      const reg = readRegistrationSync(oldPath);
      if (!reg || !registrationMatchesState(reg, state))
        return { success: false, error: 'not_registered' };
      const newPath = join(dirs.registry, `${newName}.json`);
      try {
        const target = readRegistrationSync(newPath);
        if (target && target.pid !== reg.pid && isProcessAlive(target.pid)) {
          return { success: false, error: 'name_taken' };
        }
      } catch {
        return { success: false, error: 'name_taken' };
      }
      const cwd = normalizeCwd(ctx.cwd ?? process.cwd());
      const gitBranch = getGitBranch(cwd);
      const startedAt = new Date().toISOString();
      const model = getModel(ctx, reg.model);
      atomicWriteFileSync(
        newPath,
        JSON.stringify(
          {
            ...reg,
            name: newName,
            cwd,
            gitBranch,
            startedAt,
            model,
            sessionId: getContextSessionId(ctx) || reg.sessionId,
            activity: { ...reg.activity, lastActivityAt: startedAt },
          },
          null,
          2
        )
      );
      try {
        fs.unlinkSync(oldPath);
      } catch {
        // Keep the new record if the old entry could not be removed.
      }
      applyRoutingFromRegistration(state, reg);
      state.agentName = newName;
      state.registrationStartedAt = startedAt;
      state.model = model;
      state.gitBranch = gitBranch;
      state.sessionStartedAt = startedAt;
      state.activity.lastActivityAt = startedAt;
      invalidateAgentsCache();
      return { success: true, oldName, newName };
    });
  } catch {
    return { success: false, error: 'race_lost' };
  }
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
  const join = (reg?: AgentRegistration): JoinChannelResult => {
    const existedBefore = !!getChannel(dirs, normalizedRequested);
    const record = ensureExistingOrCreateChannel(dirs, channelId, {
      create: options?.create,
      createdBy: state.agentName || undefined,
      description: options?.description,
    });
    if (!record) return { success: false, error: 'not_found' };

    if (reg) applyRoutingFromRegistration(state, reg);
    const normalized = normalizeChannelId(record.id);
    const wasCurrent = state.currentChannel === normalized;
    const alreadyJoined = state.joinedChannels.includes(normalized);
    if (!alreadyJoined) state.joinedChannels.push(normalized);
    state.currentChannel = normalized;
    if (reg) updateChannelsInRegistration(state, reg);

    return {
      success: true,
      channel: normalized,
      created: !existedBefore,
      switched: !wasCurrent,
      alreadyJoined,
    };
  };
  if (!state.registered) return join();
  return mutateOwnedRegistration(state, dirs, join) ?? { success: false, error: 'not_found' };
}
