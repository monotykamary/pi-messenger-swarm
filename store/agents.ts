import * as fs from 'node:fs';
import { join } from 'node:path';
import type { AgentRegistration, Dirs, MessengerState, ReservationConflict } from '../lib.js';
import { isProcessAlive, isValidAgentName, pathMatchesReservation } from '../lib.js';
import { MEMORY_CHANNEL_ID, normalizeChannelId } from '../channel.js';
import { applyRegistrationDefaults, normalizeCwd, normalizeJoinedChannels } from './shared.js';

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

export function getAgentRegistration(dirs: Dirs, agentName: string): AgentRegistration | null {
  const regPath = join(dirs.registry, `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = applyRegistrationDefaults(
      JSON.parse(fs.readFileSync(regPath, 'utf-8')) as AgentRegistration
    );
    if (!isProcessAlive(reg.pid)) {
      try {
        fs.unlinkSync(regPath);
      } catch {
        // Ignore cleanup errors
      }
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
  return normalizeJoinedChannels(
    registration.joinedChannels,
    registration.currentChannel,
    registration.sessionChannel
  ).includes(normalized);
}

export function getAgentPreferredChannel(registration: AgentRegistration): string {
  return normalizeChannelId(
    registration.currentChannel ?? registration.sessionChannel ?? MEMORY_CHANNEL_ID
  );
}

export function getAgentsInChannel(
  state: MessengerState,
  dirs: Dirs,
  channelId: string
): AgentRegistration[] {
  const normalized = normalizeChannelId(channelId);
  return getActiveAgents(state, dirs).filter((agent) => agentJoinedChannel(agent, normalized));
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

    let filtered = agentsCache.allAgents.filter((a) => a.name !== excludeName);
    if (scopeToFolder) {
      filtered = filtered.filter((a) => a.cwd === myCwd);
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
    if (!file.endsWith('.json')) continue;

    try {
      const content = fs.readFileSync(join(dirs.registry, file), 'utf-8');
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

  let filtered = allAgents.filter((a) => a.name !== excludeName);
  if (scopeToFolder) {
    filtered = filtered.filter((a) => a.cwd === myCwd);
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
    const existing: AgentRegistration = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
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
      const altReg: AgentRegistration = JSON.parse(fs.readFileSync(altPath, 'utf-8'));
      if (!isProcessAlive(altReg.pid)) return altName;
    } catch {
      return altName;
    }
  }

  return null;
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

export function resolveTargetChannel(
  dirs: Dirs,
  to: string,
  requestedChannel?: string
): string | null {
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

export type TargetValidation =
  | { valid: true; registration: AgentRegistration }
  | { valid: false; error: 'invalid_name' | 'not_found' | 'not_active' | 'invalid_registration' };

export function validateTargetAgent(to: string, dirs: Dirs): TargetValidation {
  if (!isValidAgentName(to)) {
    return { valid: false, error: 'invalid_name' };
  }

  const reg = getAgentRegistration(dirs, to);
  if (!reg) {
    const targetReg = join(dirs.registry, `${to}.json`);
    if (!fs.existsSync(targetReg)) return { valid: false, error: 'not_found' };
    return { valid: false, error: 'not_active' };
  }

  return { valid: true, registration: reg };
}
