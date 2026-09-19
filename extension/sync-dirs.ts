import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Dirs } from '../lib.js';

/**
 * Returns true if the registry directory exists and contains at least one .json file.
 * Injectable for testing.
 */
export function defaultRegistryHasAgents(registryPath: string): boolean {
  try {
    return fs.readdirSync(registryPath).some((f) => f.endsWith('.json'));
  } catch {
    return false;
  }
}

/**
 * Query the running harness server's /health endpoint and update dirs in-place
 * so all subsequent filesystem reads (including # autocomplete) target the
 * correct registry.
 *
 * Because dirs is captured by reference in every closure that uses it,
 * mutating the object is sufficient — no re-creation of providers is needed.
 *
 * Fallback chain (first non-empty registry wins):
 *   1. dataDir from server /health (definitive)
 *   2. cwd-based path from server /health (older servers without dataDir field,
 *      only when server cwd matches ours — cross-project servers are ignored)
 *   3. Global ~/.pi/agent/messenger (used by the pi_messenger MCP tool)
 */
export async function syncDirsFromServer(
  dirsToSync: Dirs,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  registryHasAgents: (p: string) => boolean = defaultRegistryHasAgents
): Promise<void> {
  try {
    const port = Number(process.env.PI_MESSENGER_PORT ?? 9877);
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`);
    if (response.ok) {
      const body = (await response.json()) as { dataDir?: string; cwd?: string };
      // Prefer explicit dataDir (present in server >= 0.25.20).
      // For the cwd-based fallback (older servers without dataDir): only apply
      // when the server's cwd matches ours — a foreign-project server must not
      // inject its agents into our # autocomplete.
      const serverDataDir =
        body.dataDir ??
        (body.cwd && resolve(body.cwd) === resolve(process.cwd())
          ? join(body.cwd, '.pi', 'messenger')
          : undefined);
      if (serverDataDir && serverDataDir !== dirsToSync.base) {
        dirsToSync.base = serverDataDir;
        dirsToSync.registry = join(serverDataDir, 'registry');
      }
    }
  } catch {
    // Best-effort — server may not be ready yet.
  }

  // If the resolved registry has no agent files, fall back to the global
  // registry used by the pi_messenger MCP tool (~/.pi/agent/messenger).
  if (!registryHasAgents(dirsToSync.registry)) {
    const globalBase = join(homedir(), '.pi', 'agent', 'messenger');
    const globalRegistry = join(globalBase, 'registry');
    if (globalRegistry !== dirsToSync.registry && registryHasAgents(globalRegistry)) {
      dirsToSync.base = globalBase;
      dirsToSync.registry = globalRegistry;
    }
  }
}
