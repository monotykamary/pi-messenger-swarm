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
 * The extension runs from TypeScript source via tsx — there is no
 * compiled cli.js on disk (dist/ is gitignored and not shipped).
 * The shell wrapper uses 'npx tsx' to invoke the .ts source directly.
 */
export function getCliPath(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  // Source .ts entry point (always present)
  return join(__dirname, '..', 'harness', 'cli.ts');
}

/** Resolve the project root for cwd. */
function getProjectRoot(): string {
  const __dirname = fileURLToPath(new URL('.', import.meta.url));
  return join(__dirname, '..');
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
    // Uses npx tsx so it works from source without a compiled cli.js.
    // The project root must be cwd so relative imports in cli.ts resolve.
    const projectRoot = getProjectRoot();
    const wrapperContent = `#!/bin/sh
cd "${projectRoot}" 2>/dev/null
exec npx tsx "${cliPath}" "$@"
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
    const projectRoot = getProjectRoot();

    try {
      harnessProcess = spawnChild('npx', ['tsx', cliPath, '--start'], {
        cwd: projectRoot,
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
