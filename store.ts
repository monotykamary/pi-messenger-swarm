/**
 * Pi Messenger - File Storage Operations
 */

import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentRegistration,
  type AgentMailMessage,
  type ReservationConflict,
  type MessengerState,
  type Dirs,
  type ClaimEntry,
  type CompletionEntry,
  type SpecClaims,
  type SpecCompletions,
  type AllClaims,
  type AllCompletions,
  type NameThemeConfig,
  MAX_WATCHER_RETRIES,
  isProcessAlive,
  generateMemorableName,
  isValidAgentName,
  pathMatchesReservation,
} from "./lib.js";
import {
  HEARTBEAT_CHANNEL_ID,
  MEMORY_CHANNEL_ID,
  ensureDefaultNamedChannels,
  ensureExistingOrCreateChannel,
  ensureSessionChannel,
  getChannel,
  isValidChannelId,
  normalizeChannelId,
} from "./channel.js";

// =============================================================================
// Agents Cache (Fix 1: Reduce disk I/O)
// =============================================================================

interface AgentsCache {
  allAgents: AgentRegistration[];
  filtered: Map<string, AgentRegistration[]>;
  timestamp: number;
  registryPath: string;
}

const AGENTS_CACHE_TTL_MS = 1000;
let agentsCache: AgentsCache | null = null;

export function invalidateAgentsCache(): void {
  agentsCache = null;
}

// =============================================================================
// Message Processing Guard (Fix 3: Prevent race conditions)
// =============================================================================

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MessengerState;
  dirs: Dirs;
  deliverFn: (msg: AgentMailMessage) => void;
} | null = null;

// =============================================================================
// File System Helpers
// =============================================================================

function ensureDirSync(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function normalizeCwd(cwd: string): string {
  try {
    return fs.realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

function getGitBranch(cwd: string): string | undefined {
  try {
    const result = execSync("git branch --show-current", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    if (result) return result;

    const sha = execSync("git rev-parse --short HEAD", {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    return sha ? `@${sha}` : undefined;
  } catch {
    return undefined;
  }
}

function normalizeJoinedChannels(channels: string[] | undefined, currentChannel?: string, sessionChannel?: string): string[] {
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

function keepNamedChannels(dirs: Dirs, channels: string[] | undefined): string[] {
  const kept = new Set<string>();
  for (const channel of channels ?? []) {
    if (!channel) continue;
    const normalized = normalizeChannelId(channel);
    const record = getChannel(dirs, normalized);
    if (record?.type === "session") continue;
    kept.add(normalized);
  }
  return Array.from(kept);
}

function getContextSessionId(ctx: ExtensionContext): string {
  try {
    return ctx.sessionManager.getSessionId?.() ?? "";
  } catch {
    return "";
  }
}

function ensureStateChannels(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  ensureDefaultNamedChannels(dirs, state.agentName || undefined);

  const inheritedChannel = process.env.PI_MESSENGER_CHANNEL?.trim();
  const sessionId = getContextSessionId(ctx);

  let sessionChannel = state.sessionChannel?.trim();
  let resetToSessionChannel = false;
  if (inheritedChannel) {
    const record = ensureExistingOrCreateChannel(dirs, inheritedChannel, { create: true, createdBy: state.agentName || undefined });
    sessionChannel = record?.id ?? normalizeChannelId(inheritedChannel);
    resetToSessionChannel = true;
  } else if (sessionId) {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  } else if (sessionChannel) {
    const record = ensureExistingOrCreateChannel(dirs, sessionChannel, { create: true, createdBy: state.agentName || undefined });
    sessionChannel = record?.id ?? normalizeChannelId(sessionChannel);
  } else {
    sessionChannel = ensureSessionChannel(dirs, sessionId, state.agentName || undefined).id;
    resetToSessionChannel = true;
  }

  state.sessionChannel = normalizeChannelId(sessionChannel);

  if (resetToSessionChannel) {
    state.currentChannel = state.sessionChannel;
    state.joinedChannels = normalizeJoinedChannels(keepNamedChannels(dirs, state.joinedChannels), state.sessionChannel, state.sessionChannel);
    return;
  }

  let currentChannel = state.currentChannel?.trim();
  if (currentChannel) {
    const record = ensureExistingOrCreateChannel(dirs, currentChannel, { create: true, createdBy: state.agentName || undefined });
    currentChannel = record?.id ?? normalizeChannelId(currentChannel);
  } else {
    currentChannel = state.sessionChannel;
  }

  state.currentChannel = normalizeChannelId(currentChannel);
  state.joinedChannels = normalizeJoinedChannels(state.joinedChannels, state.currentChannel, state.sessionChannel);
}

function applyRegistrationDefaults(reg: AgentRegistration): AgentRegistration {
  const currentChannel = reg.currentChannel ? normalizeChannelId(reg.currentChannel) : undefined;
  const sessionChannel = reg.sessionChannel ? normalizeChannelId(reg.sessionChannel) : currentChannel;
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

function updateChannelsInRegistration(state: MessengerState, reg: AgentRegistration): AgentRegistration {
  return {
    ...reg,
    currentChannel: state.currentChannel,
    sessionChannel: state.sessionChannel,
    joinedChannels: normalizeJoinedChannels(state.joinedChannels, state.currentChannel, state.sessionChannel),
  };
}

const LOCK_STALE_MS = 10000;

async function withSwarmLock<T>(baseDir: string, fn: () => T): Promise<T> {
  const lockPath = join(baseDir, "swarm.lock");
  const maxRetries = 50;
  const retryDelay = 100;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const stat = fs.statSync(lockPath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > LOCK_STALE_MS) {
        try {
          const pid = parseInt(fs.readFileSync(lockPath, "utf-8").trim(), 10);
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
      const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        if (i === maxRetries - 1) {
          throw new Error("Failed to acquire swarm lock");
        }
        await new Promise(resolve => setTimeout(resolve, retryDelay));
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

// =============================================================================
// Registry Operations
// =============================================================================

export function getRegistrationPath(state: MessengerState, dirs: Dirs): string {
  return join(dirs.registry, `${state.agentName}.json`);
}

export function getAgentRegistration(dirs: Dirs, agentName: string): AgentRegistration | null {
  const regPath = join(dirs.registry, `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = applyRegistrationDefaults(JSON.parse(fs.readFileSync(regPath, "utf-8")) as AgentRegistration);
    if (!isProcessAlive(reg.pid)) {
      try { fs.unlinkSync(regPath); } catch {}
      return null;
    }
    reg.cwd = normalizeCwd(reg.cwd);
    return reg;
  } catch {
    return null;
  }
}

export function agentJoinedChannel(registration: AgentRegistration, channelId: string): boolean {
  const normalized = normalizeChannelId(channelId);
  return normalizeJoinedChannels(registration.joinedChannels, registration.currentChannel, registration.sessionChannel).includes(normalized);
}

export function getAgentPreferredChannel(registration: AgentRegistration): string {
  return normalizeChannelId(registration.currentChannel ?? registration.sessionChannel ?? MEMORY_CHANNEL_ID);
}

export function getAgentsInChannel(state: MessengerState, dirs: Dirs, channelId: string): AgentRegistration[] {
  const normalized = normalizeChannelId(channelId);
  return getActiveAgents(state, dirs).filter(agent => agentJoinedChannel(agent, normalized));
}

export function getActiveAgents(state: MessengerState, dirs: Dirs): AgentRegistration[] {
  const now = Date.now();
  const excludeName = state.agentName;
  const myCwd = normalizeCwd(process.cwd());
  const scopeToFolder = state.scopeToFolder;

  const cacheKey = scopeToFolder ? `${excludeName}:${myCwd}` : excludeName;

  if (
    agentsCache &&
    agentsCache.registryPath === dirs.registry &&
    now - agentsCache.timestamp < AGENTS_CACHE_TTL_MS
  ) {
    const cachedFiltered = agentsCache.filtered.get(cacheKey);
    if (cachedFiltered) return cachedFiltered;

    let filtered = agentsCache.allAgents.filter(a => a.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter(a => a.cwd === myCwd);
    }
    agentsCache.filtered.set(cacheKey, filtered);
    return filtered;
  }

  const allAgents: AgentRegistration[] = [];

  if (!fs.existsSync(dirs.registry)) {
    agentsCache = { allAgents, filtered: new Map(), timestamp: now, registryPath: dirs.registry };
    return allAgents;
  }

  let files: string[];
  try {
    files = fs.readdirSync(dirs.registry);
  } catch {
    return allAgents;
  }

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), "utf-8");
      const reg = applyRegistrationDefaults(JSON.parse(content) as AgentRegistration);

      if (!isProcessAlive(reg.pid)) {
        try {
          fs.unlinkSync(join(dirs.registry, file));
        } catch {
          // Ignore cleanup errors
        }
        continue;
      }

      reg.cwd = normalizeCwd(reg.cwd);
      allAgents.push(reg);
    } catch {
      // Ignore malformed registrations
    }
  }

  let filtered = allAgents.filter(a => a.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter(a => a.cwd === myCwd);
  }
  const filteredMap = new Map<string, AgentRegistration[]>();
  filteredMap.set(cacheKey, filtered);

  agentsCache = { allAgents, filtered: filteredMap, timestamp: now, registryPath: dirs.registry };

  return filtered;
}

export function findAvailableName(baseName: string, dirs: Dirs): string | null {
  const basePath = join(dirs.registry, `${baseName}.json`);
  if (!fs.existsSync(basePath)) return baseName;

  try {
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, "utf-8"));
    if (!isProcessAlive(existing.pid) || existing.pid === process.pid) {
      return baseName;
    }
  } catch {
    return baseName;
  }

  for (let i = 2; i <= 99; i++) {
    const altName = `${baseName}${i}`;
    const altPath = join(dirs.registry, `${altName}.json`);

    if (!fs.existsSync(altPath)) return altName;

    try {
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, "utf-8"));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
}

export function register(state: MessengerState, dirs: Dirs, ctx: ExtensionContext, nameTheme?: NameThemeConfig): boolean {
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
          ctx.ui.notify(`Invalid agent name "${state.agentName}" - use only letters, numbers, underscore, hyphen`, "error");
        }
        return false;
      }
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      if (fs.existsSync(regPath)) {
        try {
          const existing: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
          if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
            if (ctx.hasUI) {
              ctx.ui.notify(`Agent name "${state.agentName}" already in use (PID ${existing.pid})`, "error");
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
          ctx.ui.notify("Could not find available agent name after 99 attempts", "error");
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

    ensureDirSync(getMyInboxRoot(state, dirs));
    ensureDirSync(getMyInbox(state, dirs, state.currentChannel));

    const cwd = normalizeCwd(process.cwd());
    const gitBranch = getGitBranch(cwd);
    const now = new Date().toISOString();
    const registration: AgentRegistration = {
      name: state.agentName,
      pid: process.pid,
      sessionId: getContextSessionId(ctx),
      cwd,
      model: (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : "unknown"),
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
        const msg = err instanceof Error ? err.message : "unknown error";
        ctx.ui.notify(`Failed to register: ${msg}`, "error");
      }
      return false;
    }

    let verified = false;
    let verifyError = false;
    try {
      const written: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
      verified = written.pid === process.pid;
    } catch {
      verifyError = true;
    }

    if (verified) {
      state.registered = true;
      state.model = (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : "unknown");
      state.gitBranch = gitBranch;
      state.activity.lastActivityAt = now;
      invalidateAgentsCache();
      return true;
    }

    if (verifyError) {
      try {
        const checkContent = fs.readFileSync(regPath, "utf-8");
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
        ctx.ui.notify(`Agent name "${state.agentName}" was claimed by another agent`, "error");
      }
      return false;
    }
    invalidateAgentsCache();
  }

  if (ctx.hasUI) {
    ctx.ui.notify("Failed to register after multiple attempts due to name conflicts", "error");
  }
  return false;
}

export function updateRegistration(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg = applyRegistrationDefaults(JSON.parse(fs.readFileSync(regPath, "utf-8")) as AgentRegistration);
    const currentModel = (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : reg.model);
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

export function flushActivityToRegistry(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): void {
  if (!state.registered) return;

  const regPath = getRegistrationPath(state, dirs);
  if (!fs.existsSync(regPath)) return;

  try {
    const reg = applyRegistrationDefaults(JSON.parse(fs.readFileSync(regPath, "utf-8")) as AgentRegistration);
    const currentModel = (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : reg.model);
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
    const reg = applyRegistrationDefaults(JSON.parse(fs.readFileSync(regPath, "utf-8")) as AgentRegistration);
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

export function rebindContextSession(state: MessengerState, dirs: Dirs, ctx: ExtensionContext): RebindContextSessionResult {
  const currentContextSessionId = getContextSessionId(ctx);
  const previousContextSessionId = state.contextSessionId;
  const previousCurrentChannel = state.currentChannel;
  const previousSessionChannel = state.sessionChannel;
  const previousJoinedChannels = JSON.stringify(state.joinedChannels);

  const inheritedChannel = process.env.PI_MESSENGER_CHANNEL?.trim();
  const shouldRebind = !!inheritedChannel || (!!currentContextSessionId && currentContextSessionId !== previousContextSessionId);

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
  | { success: false; error: "not_registered" | "invalid_name" | "name_taken" | "same_name" | "race_lost" };

export function renameAgent(
  state: MessengerState,
  dirs: Dirs,
  ctx: ExtensionContext,
  newName: string,
  deliverFn: (msg: AgentMailMessage) => void
): RenameResult {
  if (!state.registered) {
    return { success: false, error: "not_registered" };
  }

  if (!isValidAgentName(newName)) {
    return { success: false, error: "invalid_name" };
  }

  if (newName === state.agentName) {
    return { success: false, error: "same_name" };
  }

  const newRegPath = join(dirs.registry, `${newName}.json`);
  if (fs.existsSync(newRegPath)) {
    try {
      const existing: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
      if (isProcessAlive(existing.pid) && existing.pid !== process.pid) {
        return { success: false, error: "name_taken" };
      }
    } catch {
      // Malformed file, we can overwrite
    }
  }

  const oldName = state.agentName;
  const oldRegPath = getRegistrationPath(state, dirs);
  const oldInboxRoot = getMyInboxRoot(state, dirs);
  const newInboxRoot = join(dirs.inbox, newName);

  processAllPendingMessages(state, dirs, deliverFn);

  const cwd = normalizeCwd(process.cwd());
  const gitBranch = getGitBranch(cwd);
  const now = new Date().toISOString();
  const registration: AgentRegistration = {
    name: newName,
    pid: process.pid,
    sessionId: getContextSessionId(ctx),
    cwd,
    model: (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : "unknown"),
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
    return { success: false, error: "invalid_name" as const };
  }

  let verified = false;
  let verifyError = false;
  try {
    const written: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
    verified = written.pid === process.pid;
  } catch {
    verifyError = true;
  }

  if (!verified) {
    if (verifyError) {
      try {
        const checkReg: AgentRegistration = JSON.parse(fs.readFileSync(newRegPath, "utf-8"));
        if (checkReg.pid === process.pid) {
          fs.unlinkSync(newRegPath);
        }
      } catch {
        // Best effort cleanup
      }
    }
    return { success: false, error: "race_lost" };
  }

  try {
    fs.unlinkSync(oldRegPath);
  } catch {
    // Ignore - old file might already be gone
  }

  state.agentName = newName;

  ensureDirSync(newInboxRoot);
  for (const channel of state.joinedChannels) {
    ensureDirSync(join(newInboxRoot, normalizeChannelId(channel)));
  }

  try {
    fs.rmSync(oldInboxRoot, { recursive: true, force: true });
  } catch {
    // Ignore
  }

  state.model = (ctx.model as { id?: string } | undefined)?.id ?? (typeof ctx.model === "string" ? ctx.model : "unknown");
  state.gitBranch = gitBranch;
  state.sessionStartedAt = now;
  state.activity.lastActivityAt = now;
  invalidateAgentsCache();
  return { success: true, oldName, newName };
}

export function getConflictsWithOtherAgents(
  filePath: string,
  state: MessengerState,
  dirs: Dirs
): ReservationConflict[] {
  const conflicts: ReservationConflict[] = [];
  const agents = getActiveAgents(state, dirs);

  for (const agent of agents) {
    if (!agent.reservations) continue;
    for (const res of agent.reservations) {
      if (pathMatchesReservation(filePath, res.pattern)) {
        conflicts.push({
          path: filePath,
          agent: agent.name,
          pattern: res.pattern,
          reason: res.reason,
          registration: agent,
        });
      }
    }
  }

  return conflicts;
}

export type JoinChannelResult =
  | { success: true; channel: string; created: boolean; switched: boolean; alreadyJoined: boolean }
  | { success: false; error: "invalid_channel" | "not_found" };

export function joinChannel(
  state: MessengerState,
  dirs: Dirs,
  channelId: string,
  options?: { create?: boolean; description?: string }
): JoinChannelResult {
  if (!isValidChannelId(channelId)) {
    return { success: false, error: "invalid_channel" };
  }

  const normalizedRequested = normalizeChannelId(channelId);
  const existedBefore = !!getChannel(dirs, normalizedRequested);
  const record = ensureExistingOrCreateChannel(dirs, channelId, {
    create: options?.create,
    createdBy: state.agentName || undefined,
    description: options?.description,
  });
  if (!record) {
    return { success: false, error: "not_found" };
  }

  const normalized = normalizeChannelId(record.id);
  const wasCurrent = state.currentChannel === normalized;
  const alreadyJoined = state.joinedChannels.includes(normalized);
  if (!alreadyJoined) {
    state.joinedChannels = [...state.joinedChannels, normalized];
  }
  state.currentChannel = normalized;
  ensureDirSync(getMyInbox(state, dirs, normalized));
  syncChannelsToRegistration(state, dirs);

  return {
    success: true,
    channel: normalized,
    created: !existedBefore,
    switched: !wasCurrent,
    alreadyJoined,
  };
}

// =============================================================================
// Swarm Coordination
// =============================================================================

const CLAIMS_FILE = "claims.json";
const COMPLETIONS_FILE = "completions.json";

function readClaimsSync(dirs: Dirs): AllClaims {
  const path = join(dirs.base, CLAIMS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllClaims;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function readCompletionsSync(dirs: Dirs): AllCompletions {
  const path = join(dirs.base, COMPLETIONS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as AllCompletions;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function writeClaimsSync(dirs: Dirs, claims: AllClaims): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, CLAIMS_FILE);
  const temp = join(dirs.base, `${CLAIMS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(claims, null, 2));
  fs.renameSync(temp, target);
}

function writeCompletionsSync(dirs: Dirs, completions: AllCompletions): void {
  ensureDirSync(dirs.base);
  const target = join(dirs.base, COMPLETIONS_FILE);
  const temp = join(dirs.base, `${COMPLETIONS_FILE}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(temp, JSON.stringify(completions, null, 2));
  fs.renameSync(temp, target);
}

function isClaimStale(claim: ClaimEntry, dirs: Dirs): boolean {
  if (!isProcessAlive(claim.pid)) return true;
  const regPath = join(dirs.registry, `${claim.agent}.json`);
  if (!fs.existsSync(regPath)) return true;
  try {
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, "utf-8"));
    if (!isProcessAlive(reg.pid)) return true;
    if (reg.sessionId !== claim.sessionId) return true;
  } catch {
    return true;
  }
  return false;
}

function cleanupStaleClaims(claims: AllClaims, dirs: Dirs): number {
  let removed = 0;
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (isClaimStale(claim, dirs)) {
        delete tasks[taskId];
        removed++;
      }
    }
    if (Object.keys(tasks).length === 0) {
      delete claims[spec];
    }
  }
  return removed;
}

function filterStaleClaims(claims: AllClaims, dirs: Dirs): AllClaims {
  const filtered: AllClaims = {};
  for (const [spec, tasks] of Object.entries(claims)) {
    const filteredTasks: SpecClaims = {};
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (!isClaimStale(claim, dirs)) {
        filteredTasks[taskId] = claim;
      }
    }
    if (Object.keys(filteredTasks).length > 0) {
      filtered[spec] = filteredTasks;
    }
  }
  return filtered;
}

function findAgentClaim(claims: AllClaims, agent: string): { spec: string; taskId: string } | null {
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId };
      }
    }
  }
  return null;
}

export function getClaims(dirs: Dirs): AllClaims {
  const claims = readClaimsSync(dirs);
  return filterStaleClaims(claims, dirs);
}

export function getClaimsForSpec(dirs: Dirs, specPath: string): SpecClaims {
  const claims = getClaims(dirs);
  return claims[specPath] ?? {};
}

export function getCompletions(dirs: Dirs): AllCompletions {
  return readCompletionsSync(dirs);
}

export function getCompletionsForSpec(dirs: Dirs, specPath: string): SpecCompletions {
  const completions = getCompletions(dirs);
  return completions[specPath] ?? {};
}

export function getAgentCurrentClaim(
  dirs: Dirs,
  agent: string
): { spec: string; taskId: string; reason?: string } | null {
  const claims = getClaims(dirs);
  for (const [spec, tasks] of Object.entries(claims)) {
    for (const [taskId, claim] of Object.entries(tasks)) {
      if (claim.agent === agent) {
        return { spec, taskId, reason: claim.reason };
      }
    }
  }
  return null;
}

export type ClaimResult =
  | { success: true; claimedAt: string }
  | { success: false; error: "already_claimed"; conflict: ClaimEntry }
  | { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } };

export function isClaimSuccess(r: ClaimResult): r is { success: true; claimedAt: string } {
  return r.success === true;
}
export function isClaimAlreadyClaimed(r: ClaimResult): r is { success: false; error: "already_claimed"; conflict: ClaimEntry } {
  return "error" in r && r.error === "already_claimed";
}
export function isClaimAlreadyHaveClaim(r: ClaimResult): r is { success: false; error: "already_have_claim"; existing: { spec: string; taskId: string } } {
  return "error" in r && r.error === "already_have_claim";
}

export async function claimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  sessionId: string,
  pid: number,
  reason?: string
): Promise<ClaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existing = findAgentClaim(claims, agent);
    if (existing) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_have_claim", existing };
    }

    const existingClaim = claims[specPath]?.[taskId];
    if (existingClaim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_claimed", conflict: existingClaim };
    }

    if (!claims[specPath]) claims[specPath] = {};
    const newClaim: ClaimEntry = {
      agent,
      sessionId,
      pid,
      claimedAt: new Date().toISOString(),
      reason,
    };
    claims[specPath][taskId] = newClaim;
    writeClaimsSync(dirs, claims);
    return { success: true, claimedAt: newClaim.claimedAt };
  });
}

export type UnclaimResult =
  | { success: true }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string };

export function isUnclaimSuccess(r: UnclaimResult): r is { success: true } {
  return r.success === true;
}
export function isUnclaimNotYours(r: UnclaimResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function unclaimTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string
): Promise<UnclaimResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }
    writeClaimsSync(dirs, claims);
    return { success: true };
  });
}

export type CompleteResult =
  | { success: true; completedAt: string }
  | { success: false; error: "not_claimed" }
  | { success: false; error: "not_your_claim"; claimedBy: string }
  | { success: false; error: "already_completed"; completion: CompletionEntry };

export function isCompleteSuccess(r: CompleteResult): r is { success: true; completedAt: string } {
  return r.success === true;
}
export function isCompleteAlreadyCompleted(r: CompleteResult): r is { success: false; error: "already_completed"; completion: CompletionEntry } {
  return "error" in r && r.error === "already_completed";
}
export function isCompleteNotYours(r: CompleteResult): r is { success: false; error: "not_your_claim"; claimedBy: string } {
  return "error" in r && r.error === "not_your_claim";
}

export async function completeTask(
  dirs: Dirs,
  specPath: string,
  taskId: string,
  agent: string,
  notes?: string
): Promise<CompleteResult> {
  return withSwarmLock(dirs.base, () => {
    const claims = readClaimsSync(dirs);
    const completions = readCompletionsSync(dirs);
    const removed = cleanupStaleClaims(claims, dirs);

    const existingCompletion = completions[specPath]?.[taskId];
    if (existingCompletion) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "already_completed", completion: existingCompletion };
    }

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_claimed" };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: "not_your_claim", claimedBy: claim.agent };
    }

    delete claims[specPath][taskId];
    if (Object.keys(claims[specPath]).length === 0) {
      delete claims[specPath];
    }

    if (!completions[specPath]) completions[specPath] = {};
    const completion: CompletionEntry = {
      completedBy: agent,
      completedAt: new Date().toISOString(),
      notes,
    };
    completions[specPath][taskId] = completion;

    writeCompletionsSync(dirs, completions);
    writeClaimsSync(dirs, claims);
    return { success: true, completedAt: completion.completedAt };
  });
}

// =============================================================================
// Messaging Operations
// =============================================================================

function getMyInboxRoot(state: MessengerState, dirs: Dirs): string {
  return join(dirs.inbox, state.agentName);
}

export function getMyInbox(state: MessengerState, dirs: Dirs, channelId: string = state.currentChannel): string {
  return join(getMyInboxRoot(state, dirs), normalizeChannelId(channelId));
}

export function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;

  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;

  try {
    const inbox = getMyInbox(state, dirs, state.currentChannel);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs.readdirSync(inbox).filter(f => f.endsWith(".json")).sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      try {
        const content = fs.readFileSync(msgPath, "utf-8");
        const msg = JSON.parse(content) as AgentMailMessage;
        msg.channel = msg.channel ? normalizeChannelId(msg.channel) : state.currentChannel;
        deliverFn(msg);
        fs.unlinkSync(msgPath);
      } catch {
        try {
          fs.unlinkSync(msgPath);
        } catch {
          // Already gone or can't delete
        }
      }
    }
  } finally {
    isProcessingMessages = false;

    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliverFn);
    }
  }
}

export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  to: string,
  text: string,
  replyTo?: string,
  channelId?: string
): AgentMailMessage {
  const resolvedChannel = normalizeChannelId(channelId ?? state.currentChannel);
  const targetInbox = join(dirs.inbox, to, resolvedChannel);
  ensureDirSync(targetInbox);

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
    channel: resolvedChannel,
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));

  return msg;
}

export function resolveTargetChannel(dirs: Dirs, to: string, requestedChannel?: string): string | null {
  if (requestedChannel) {
    const channel = normalizeChannelId(requestedChannel);
    const reg = getAgentRegistration(dirs, to);
    if (!reg) return null;
    return agentJoinedChannel(reg, channel) ? channel : null;
  }

  const reg = getAgentRegistration(dirs, to);
  if (!reg) return null;
  return getAgentPreferredChannel(reg);
}

// =============================================================================
// Watcher
// =============================================================================

const WATCHER_DEBOUNCE_MS = 50;

export function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs, state.currentChannel);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliverFn);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliverFn);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on("error", () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

export function stopWatcher(state: MessengerState): void {
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
}

// =============================================================================
// Target Validation
// =============================================================================

export type TargetValidation =
  | { valid: true; registration: AgentRegistration }
  | { valid: false; error: "invalid_name" | "not_found" | "not_active" | "invalid_registration" };

export function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: "invalid_name" };
  }

  const reg = getAgentRegistration(dirs, to);
  if (!reg) {
    const targetReg = join(dirs.registry, `${to}.json`);
    if (!fs.existsSync(targetReg)) return { valid: false, error: "not_found" };
    return { valid: false, error: "not_active" };
  }

  return { valid: true, registration: reg };
}
