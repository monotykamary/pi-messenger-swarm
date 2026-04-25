import * as fs from 'node:fs';
import * as path from 'node:path';
import { isProcessAlive } from '../../lib.js';
import { logFeedEvent } from '../../feed/index.js';
import { appendTaskEvent } from './events.js';
import { replayTasks } from './events.js';

/**
 * Check if an agent is active based on registry file and PID.
 * Returns: true (active), false (crashed/dead), null (unknown/no registry)
 */
function isAgentActive(cwd: string, agentName: string): boolean | null {
  const regPath = path.join(cwd, '.pi', 'messenger', 'registry', `${agentName}.json`);
  if (!fs.existsSync(regPath)) return null;

  try {
    const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    if (!reg.pid || !isProcessAlive(reg.pid)) return false;
    return true;
  } catch {
    return null;
  }
}

/**
 * Clean up stale task claims from crashed or departed agents.
 * Returns the number of claims that were cleaned up.
 */
export function cleanupStaleTaskClaims(cwd: string, sessionId: string): number {
  const registryDir = path.join(cwd, '.pi', 'messenger', 'registry');
  if (!fs.existsSync(registryDir)) return 0;

  // Use replayTasks directly instead of getTasks to avoid triggering cleanup recursively
  const tasks = replayTasks(cwd, sessionId);
  let cleaned = 0;

  const knownAgents = fs.existsSync(registryDir)
    ? fs
        .readdirSync(registryDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
    : [];

  for (const task of tasks) {
    if (task.status !== 'in_progress' || !task.claimed_by) continue;

    const active = isAgentActive(cwd, task.claimed_by);
    if (active === false) {
      // Append release event directly (same as unclaimTask)
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      logFeedEvent(
        cwd,
        task.claimed_by,
        'task.reset',
        task.id,
        'agent crashed - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    } else if (active === null && knownAgents.length > 0) {
      // Append release event directly (same as unclaimTask)
      appendTaskEvent(cwd, sessionId, {
        taskId: task.id,
        type: 'released',
        timestamp: new Date().toISOString(),
        agent: task.claimed_by,
      });
      logFeedEvent(
        cwd,
        task.claimed_by,
        'task.reset',
        task.id,
        'agent left - task auto-unclaimed',
        task.channel ?? 'unknown'
      );
      cleaned++;
    }
  }

  return cleaned;
}
