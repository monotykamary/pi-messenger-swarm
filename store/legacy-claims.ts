import * as fs from 'node:fs';
import { join } from 'node:path';
import type {
  AgentRegistration,
  AllClaims,
  AllCompletions,
  ClaimEntry,
  CompletionEntry,
  Dirs,
  SpecClaims,
  SpecCompletions,
} from '../lib.js';
import { isProcessAlive } from '../lib.js';
import { ensureDirSync, withSwarmLock } from './shared.js';

const CLAIMS_FILE = 'claims.json';
const COMPLETIONS_FILE = 'completions.json';

function readClaimsSync(dirs: Dirs): AllClaims {
  const path = join(dirs.base, CLAIMS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as AllClaims;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Ignore
  }
  return {};
}

function readCompletionsSync(dirs: Dirs): AllCompletions {
  const path = join(dirs.base, COMPLETIONS_FILE);
  if (!fs.existsSync(path)) return {};
  try {
    const raw = fs.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as AllCompletions;
    if (parsed && typeof parsed === 'object') return parsed;
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
    const reg: AgentRegistration = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
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
  | { success: false; error: 'already_claimed'; conflict: ClaimEntry }
  | { success: false; error: 'already_have_claim'; existing: { spec: string; taskId: string } };

export function isClaimSuccess(r: ClaimResult): r is { success: true; claimedAt: string } {
  return r.success === true;
}

export function isClaimAlreadyClaimed(
  r: ClaimResult
): r is { success: false; error: 'already_claimed'; conflict: ClaimEntry } {
  return 'error' in r && r.error === 'already_claimed';
}

export function isClaimAlreadyHaveClaim(
  r: ClaimResult
): r is {
  success: false;
  error: 'already_have_claim';
  existing: { spec: string; taskId: string };
} {
  return 'error' in r && r.error === 'already_have_claim';
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
      return { success: false, error: 'already_have_claim', existing };
    }

    const existingClaim = claims[specPath]?.[taskId];
    if (existingClaim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: 'already_claimed', conflict: existingClaim };
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
  | { success: false; error: 'not_claimed' }
  | { success: false; error: 'not_your_claim'; claimedBy: string };

export function isUnclaimSuccess(r: UnclaimResult): r is { success: true } {
  return r.success === true;
}

export function isUnclaimNotYours(
  r: UnclaimResult
): r is { success: false; error: 'not_your_claim'; claimedBy: string } {
  return 'error' in r && r.error === 'not_your_claim';
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
      return { success: false, error: 'not_claimed' };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: 'not_your_claim', claimedBy: claim.agent };
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
  | { success: false; error: 'not_claimed' }
  | { success: false; error: 'not_your_claim'; claimedBy: string }
  | { success: false; error: 'already_completed'; completion: CompletionEntry };

export function isCompleteSuccess(r: CompleteResult): r is { success: true; completedAt: string } {
  return r.success === true;
}

export function isCompleteAlreadyCompleted(
  r: CompleteResult
): r is { success: false; error: 'already_completed'; completion: CompletionEntry } {
  return 'error' in r && r.error === 'already_completed';
}

export function isCompleteNotYours(
  r: CompleteResult
): r is { success: false; error: 'not_your_claim'; claimedBy: string } {
  return 'error' in r && r.error === 'not_your_claim';
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
      return { success: false, error: 'already_completed', completion: existingCompletion };
    }

    const claim = claims[specPath]?.[taskId];
    if (!claim) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: 'not_claimed' };
    }
    if (claim.agent !== agent) {
      if (removed > 0) writeClaimsSync(dirs, claims);
      return { success: false, error: 'not_your_claim', claimedBy: claim.agent };
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
