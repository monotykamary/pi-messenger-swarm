/**
 * Harness server lifecycle and CLI shell alias management.
 */

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild, type ChildProcess } from 'node:child_process';

/**
 * Resolve the path to the CLI entry point.
 * Works regardless of how the extension is loaded (source via tsx, or compiled dist/).
 */
export function getCliPath(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // When running from dist/: __dirname = .../dist, so dist/harness/cli.js exists
  const compiledPath = join(__dirname, 'harness', 'cli.js');
  if (fs.existsSync(compiledPath)) return compiledPath;
  // When running from source via tsx: __dirname = project root
  // Need to use dist/harness/cli.js (built output)
  const fromSource = join(__dirname, 'dist', 'harness', 'cli.js');
  if (fs.existsSync(fromSource)) return fromSource;
  // Last resort: return the expected compiled path even if it doesn't exist yet
  return compiledPath;
}

/**
 * Write a small shell wrapper script at ~/.pi/agent/bin/pi-messenger-swarm
 * that invokes the CLI via node. Pi adds ~/.pi/agent/bin/ to PATH for
 * every bash invocation (`getShellEnv()` prepends it), so the CLI becomes
 * available as a normal command regardless of install method.
 *
 * Uses a wrapper script instead of a symlink because the CLI's location
 * depends on whether the extension runs from source (tsx) or compiled (dist/).
 */
export function installShellAlias(): void {
  try {
    const agentBinDir = join(homedir(), '.pi', 'agent', 'bin');
    if (!fs.existsSync(agentBinDir)) {
      fs.mkdirSync(agentBinDir, { recursive: true });
    }
    const cliPath = getCliPath();
    const linkPath = join(agentBinDir, 'pi-messenger-swarm');

    // Write a shell wrapper that resolves the correct node + cli path
    const wrapperContent = `#!/bin/sh
exec node "${cliPath}" "$@"
`;

    // Only write if content differs (avoids unnecessary writes on every session_start)
    let currentContent: string | null = null;
    try {
      currentContent = fs.readFileSync(linkPath, 'utf-8');
    } catch {
      // doesn't exist
    }
    if (currentContent !== wrapperContent) {
      fs.writeFileSync(linkPath, wrapperContent, { mode: 0o755 });
    }
  } catch {
    // Best effort — CLI path is still available via getCliPath()
  }
}

export interface HarnessServerController {
  start(): void;
  stop(): void;
}

export function createHarnessServer(): HarnessServerController {
  let harnessProcess: ChildProcess | null = null;

  function start(): void {
    if (harnessProcess) return;
    // Spawned subagents reuse their parent's harness server —
    // the CLI forwards agent identity headers on every request.
    if (process.env.PI_SWARM_SPAWNED === '1') return;

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
    };

    if (process.env.PI_MESSENGER_DIR) {
      env.PI_MESSENGER_DIR = process.env.PI_MESSENGER_DIR;
    }
    if (process.env.PI_MESSENGER_GLOBAL) {
      env.PI_MESSENGER_GLOBAL = process.env.PI_MESSENGER_GLOBAL;
    }

    const cliPath = getCliPath();

    try {
      harnessProcess = spawnChild('node', [cliPath, '--start'], {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        env,
      });
      harnessProcess.unref();
    } catch {
      // Harness server is optional — the extension still works for lifecycle hooks
    }
  }

  function stop(): void {
    if (!harnessProcess) return;
    try {
      harnessProcess.kill('SIGTERM');
    } catch {
      // Best effort
    }
    harnessProcess = null;
  }

  return { start, stop };
}
