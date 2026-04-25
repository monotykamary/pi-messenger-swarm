/**
 * Reservation enforcement — blocks edit/write to files reserved by other agents.
 */

import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { MessengerState, Dirs } from '../lib.js';
import { extractFolder } from '../lib.js';
import * as store from '../store.js';

export function handleReservationEnforcement(
  event: { toolName: string; input: unknown },
  _ctx: ExtensionContext,
  state: MessengerState,
  dirs: Dirs
): { block: true; reason: string } | undefined {
  if (!['edit', 'write'].includes(event.toolName)) return;

  const input = event.input as Record<string, unknown>;
  const filePath = typeof input.path === 'string' ? input.path : null;
  if (!filePath) return;

  const conflicts = store.getConflictsWithOtherAgents(filePath, state, dirs);
  if (conflicts.length === 0) return;

  const c = conflicts[0];
  const folder = extractFolder(c.registration.cwd);
  const locationPart = c.registration.gitBranch
    ? ` (in ${folder} on ${c.registration.gitBranch})`
    : ` (in ${folder})`;

  const lines = [filePath, `Reserved by: ${c.agent}${locationPart}`];
  if (c.reason) lines.push(`Reason: "${c.reason}"`);
  lines.push('');
  lines.push(`Coordinate via pi-messenger-swarm send ${c.agent} "..."`);

  return { block: true, reason: lines.join('\n') };
}
