#!/usr/bin/env node
/**
 * pi-messenger-swarm — natural CLI for multi-agent coordination.
 *
 * Usage:
 *   pi-messenger-swarm join [--channel dev]
 *   pi-messenger-swarm swarm [--channel dev]
 *   pi-messenger-swarm task list
 *   pi-messenger-swarm task claim task-1
 *   pi-messenger-swarm task create --title "Fix bug" [--content "..."] [--depends-on task-2]
 *   pi-messenger-swarm task progress task-1 "Fixed the race"
 *   pi-messenger-swarm task done task-1 "All tests passing"
 *   pi-messenger-swarm task show task-1
 *   pi-messenger-swarm task unclaim task-1
 *   pi-messenger-swarm task block task-1 [--reason "Awaiting API"]
 *   pi-messenger-swarm task unblock task-1
 *   pi-messenger-swarm task reset task-1 [--cascade]
 *   pi-messenger-swarm task archive-done
 *   pi-messenger-swarm task ready
 *   pi-messenger-swarm send AgentName "Hello there"
 *   pi-messenger-swarm send #memory "Remember this"
 *   pi-messenger-swarm feed [--limit 20] [--channel dev]
 *   pi-messenger-swarm status
 *   pi-messenger-swarm list
 *   pi-messenger-swarm whois AgentName
 *   pi-messenger-swarm reserve src/auth/ [--reason task-1]
 *   pi-messenger-swarm release
 *   pi-messenger-swarm set-status "debugging auth"
 *   pi-messenger-swarm rename NewName
 *   pi-messenger-swarm spawn --role Researcher "Analyze the protocol" [--persona "..."] [--task-id task-1] [--agent-file path] [--objective "..."] [--context "..."]
 *   pi-messenger-swarm spawn list
 *   pi-messenger-swarm spawn history
 *   pi-messenger-swarm spawn stop <id>
 *   pi-messenger-swarm --status
 *   pi-messenger-swarm --start
 *   pi-messenger-swarm --stop
 *   pi-messenger-swarm --restart
 *   pi-messenger-swarm --logs
 *
 * Also accepts JSON for programmatic use:
 *   pi-messenger-swarm '{ "action": "task.claim", "id": "task-1" }'
 *
 * Agent identity is resolved automatically from the process tree —
 * no environment variables required. The CLI finds its parent pi process
 * and sends the PID to the harness server, which matches it against
 * registrations on disk.
 */

import { execSync, spawn as spawnChild } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as http from 'node:http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PI_MESSENGER_PORT ?? 9877);
const HOST = '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const LOG = process.env.PI_MESSENGER_LOG ?? '/tmp/pi-messenger-swarm.log';
const SERVER_SCRIPT = path.resolve(__dirname, 'server.js');

// =============================================================================
// HTTP helpers
// =============================================================================

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
  });
}

function httpPost(
  url: string,
  body: string,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const data = Buffer.from(body, 'utf-8');
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-length': data.length,
          ...extraHeaders,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ status: 0, body: 'timeout' });
    });
    req.write(data);
    req.end();
  });
}

/**
 * Walk the process tree to find the parent "pi" process PID.
 *
 * When the CLI runs inside a pi bash session, the ancestry looks like:
 *   zsh → pi (PID N) → bash -c "pi-messenger-swarm ..." → node (CLI)
 *
 * The wrapper script (`exec node ...`) replaces bash, so process.ppid
 * is typically the pi PID directly.  As a fallback, we walk up a few
 * levels using `ps` to find a process named "pi".
 *
 * Returns undefined when not running inside pi (human terminal, CI, etc.).
 */
function findCallerPid(): number | undefined {
  try {
    // Fast path: direct parent is pi (wrapper replaces bash via exec)
    const ppid = process.ppid;
    const cmd = execSync(`ps -o comm= -p ${ppid}`, { encoding: 'utf-8', timeout: 1000 }).trim();
    if (cmd === 'pi') return ppid;

    // Walk up a few more levels
    let pid = ppid;
    for (let i = 0; i < 5; i++) {
      const ppidStr = execSync(`ps -o ppid= -p ${pid}`, {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim();
      const nextPid = parseInt(ppidStr, 10);
      if (isNaN(nextPid) || nextPid <= 1) break;
      const nextCmd = execSync(`ps -o comm= -p ${nextPid}`, {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim();
      if (nextCmd === 'pi') return nextPid;
      pid = nextPid;
    }
  } catch {
    // ps unavailable (unlikely on macOS/Linux)
  }
  return undefined;
}

/**
 * Read the session ID from .pi/messenger/session-id, written by the
 * extension at session_start. This bridges the gap between pi's
 * SessionManager (only available in-process) and the harness server.
 */
function readSessionIdFromFile(): string | undefined {
  try {
    const cwd = process.cwd();
    const sessionFilePath = path.join(cwd, '.pi', 'messenger', 'session-id');
    if (fs.existsSync(sessionFilePath)) {
      const id = fs.readFileSync(sessionFilePath, 'utf-8').trim();
      if (id) return id;
    }
  } catch {
    // Not available
  }
  return undefined;
}

function agentHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const callerPid = findCallerPid();
  if (callerPid) headers['x-caller-pid'] = String(callerPid);
  const sessionId = readSessionIdFromFile();
  if (sessionId) headers['x-session-id'] = sessionId;
  // Inherited channel hint from subagent spawn (PI_MESSENGER_CHANNEL is set
  // by spawn.ts when it launches a child pi process — this is the only env var
  // still used for identity, and it's only needed on the very first subagent call).
  if (process.env.PI_MESSENGER_CHANNEL)
    headers['x-messenger-channel'] = process.env.PI_MESSENGER_CHANNEL;
  return headers;
}

// =============================================================================
// Server lifecycle
// =============================================================================

async function isUp(): Promise<boolean> {
  const { status } = await httpGet(`${BASE_URL}/health`);
  return status === 200;
}

async function startServer(): Promise<boolean> {
  if (await isUp()) return true;

  let serverScript = SERVER_SCRIPT;
  if (!fs.existsSync(serverScript)) {
    const tsPath = path.resolve(__dirname, '..', 'harness', 'server.ts');
    if (fs.existsSync(tsPath)) serverScript = tsPath;
  }

  const useTsx = serverScript.endsWith('.ts');
  const cmd = useTsx ? 'npx' : 'node';
  const args = useTsx ? ['tsx', serverScript] : [serverScript];

  const env: Record<string, string> = {};
  for (const key of ['PI_MESSENGER_DIR', 'PI_MESSENGER_GLOBAL'] as const) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  const child = spawnChild(cmd, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    env: { ...process.env, ...env, PI_MESSENGER_PORT: String(PORT), PI_MESSENGER_LOG: LOG },
  });
  child.unref();

  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isUp()) return true;
  }

  process.stderr.write(`pi-messenger-swarm: server failed to start on ${BASE_URL} (see ${LOG})\n`);
  return false;
}

// =============================================================================
// Action dispatch
// =============================================================================

async function postAction(jsonBody: string): Promise<void> {
  const { status, body } = await httpPost(`${BASE_URL}/action`, jsonBody, agentHeaders());
  if (status === 200) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.ok && parsed.result?.text) {
        process.stdout.write(parsed.result.text + '\n');
      } else if (!parsed.ok) {
        process.stderr.write(`Error: ${parsed.error}\n`);
        process.exit(1);
      }
    } catch {
      if (body.trim()) process.stdout.write(body + '\n');
    }
  } else if (status === 0) {
    process.stderr.write(`Error: cannot reach harness server at ${BASE_URL}\n`);
    process.exit(1);
  } else {
    try {
      const parsed = JSON.parse(body);
      process.stderr.write(`Error: ${parsed.error ?? body}\n`);
    } catch {
      process.stderr.write(`Error: HTTP ${status} — ${body}\n`);
    }
    process.exit(1);
  }
}

/** Build the action JSON from parsed subcommand args */
function buildAction(params: Record<string, unknown>): string {
  return JSON.stringify(params);
}

// =============================================================================
// Argument parser — natural subcommand syntax
// =============================================================================

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    args.splice(idx, 2);
    return args.splice(idx - 1, 1)[0]; // already removed by splice above, need to re-read
  }
  return undefined;
}

function extractFlag(args: string[], name: string): string | undefined {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1 && idx + 1 < args.length) {
    const val = args[idx + 1];
    args.splice(idx, 2);
    return val;
  }
  return undefined;
}

function extractFlagBool(args: string[], name: string): boolean {
  const idx = args.findIndex((a) => a === `--${name}`);
  if (idx !== -1) {
    args.splice(idx, 1);
    return true;
  }
  return false;
}

function positional(args: string[], index: number): string | undefined {
  // Filter out flags first, return the Nth positional
  const positional = args.filter((a) => !a.startsWith('--'));
  return positional[index];
}

// =============================================================================
// CLI entrypoint
// =============================================================================

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  if (rawArgs.length === 0) {
    process.stderr.write('pi-messenger-swarm: no command provided. Use --help for usage.\n');
    process.exit(1);
  }

  const first = rawArgs[0];

  // --- Meta commands (no server needed for --help) ---
  if (first === '--help' || first === '-h') {
    process.stdout.write(`pi-messenger-swarm — multi-agent coordination CLI

Usage:
  pi-messenger-swarm join [--channel dev] [--create]
  pi-messenger-swarm status
  pi-messenger-swarm list
  pi-messenger-swarm whois <name>
  pi-messenger-swarm feed [--limit 20] [--channel dev]
  pi-messenger-swarm send <to> <message>
  pi-messenger-swarm swarm [--channel dev]
  pi-messenger-swarm reserve <path...> [--reason <text>]
  pi-messenger-swarm release [--paths <path...>]
  pi-messenger-swarm set-status <message>
  pi-messenger-swarm rename <name>

  pi-messenger-swarm task list
  pi-messenger-swarm task ready
  pi-messenger-swarm task show <id>
  pi-messenger-swarm task create --title "..." [--content "..."] [--depends-on <id>]
  pi-messenger-swarm task claim <id>
  pi-messenger-swarm task unclaim <id>
  pi-messenger-swarm task progress <id> <message>
  pi-messenger-swarm task done <id> <summary>
  pi-messenger-swarm task block <id> [--reason "..."]
  pi-messenger-swarm task unblock <id>
  pi-messenger-swarm task reset <id> [--cascade]
  pi-messenger-swarm task archive-done

  pi-messenger-swarm spawn --role Researcher "Analyze X" [--persona "..."] [--task-id <id>] [--name <name>] [--agent-file <path>] [--objective "..."] [--context "..."]
  pi-messenger-swarm spawn list
  pi-messenger-swarm spawn history
  pi-messenger-swarm spawn stop <id>

  pi-messenger-swarm --status    Check if harness server is running
  pi-messenger-swarm --start     Start the harness server
  pi-messenger-swarm --stop      Stop the harness server
  pi-messenger-swarm --restart    Restart the harness server
  pi-messenger-swarm --logs      Tail the server log

Also accepts JSON for programmatic use:
  pi-messenger-swarm '{ "action": "join" }'
  pi-messenger-swarm '{ "action": "task.claim", "id": "task-1" }'

Environment:
  PI_MESSENGER_PORT     Server port (default: 9877)
  PI_MESSENGER_LOG      Log file (default: /tmp/pi-messenger-swarm.log)
  PI_MESSENGER_DIR     Data directory (project-scoped by default)
  PI_MESSENGER_GLOBAL  Use global data directory if set
`);
    return;
  }

  // --- Server management commands ---
  if (first === '--status') {
    const { status, body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(status === 200 ? body + '\n' : '{"ok":false,"error":"down"}\n');
    process.exit(status === 200 ? 0 : 1);
  }

  if (first === '--start') {
    await startServer();
    const { body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(body + '\n');
    return;
  }

  if (first === '--stop') {
    if (await isUp()) {
      await httpPost(`${BASE_URL}/quit`, '');
      process.stdout.write('{"ok":true,"stopped":true}\n');
    } else {
      process.stdout.write('{"ok":true,"stopped":false,"note":"already down"}\n');
    }
    return;
  }

  if (first === '--restart') {
    if (await isUp()) {
      await httpPost(`${BASE_URL}/quit`, '');
      await new Promise((r) => setTimeout(r, 200));
    }
    await startServer();
    const { body } = await httpGet(`${BASE_URL}/health`);
    process.stdout.write(body + '\n');
    return;
  }

  if (first === '--logs') {
    const { spawn } = await import('node:child_process');
    spawn('tail', ['-f', LOG], { stdio: 'inherit' });
    return;
  }

  // --- JSON passthrough ---
  // If the first arg looks like a JSON object, pass it through directly
  if (first.startsWith('{')) {
    if (!(await startServer())) process.exit(1);
    await postAction(first);
    return;
  }

  // --- Natural subcommands ---
  if (!(await startServer())) process.exit(1);

  const args = [...rawArgs]; // mutable copy
  const action = args.shift()!;

  switch (action) {
    // ---- Coordination ----
    case 'join': {
      const channel = extractFlag(args, 'channel');
      const create = extractFlagBool(args, 'create');
      await postAction(
        buildAction({ action: 'join', channel: channel || undefined, create: create || undefined })
      );
      break;
    }
    case 'status': {
      await postAction(buildAction({ action: 'status' }));
      break;
    }
    case 'list': {
      await postAction(buildAction({ action: 'list' }));
      break;
    }
    case 'whois': {
      const name = args[0];
      if (!name) {
        process.stderr.write('Error: whois requires a name.\n');
        process.exit(1);
      }
      await postAction(buildAction({ action: 'whois', name }));
      break;
    }
    case 'feed': {
      const limit = extractFlag(args, 'limit');
      const channel = extractFlag(args, 'channel');
      await postAction(
        buildAction({ action: 'feed', limit: limit ? Number(limit) : undefined, channel })
      );
      break;
    }
    case 'send': {
      const to = args[0];
      const message = args.slice(1).join(' ');
      if (!to || !message) {
        process.stderr.write('Error: send requires <to> <message>.\n');
        process.exit(1);
      }
      await postAction(buildAction({ action: 'send', to, message }));
      break;
    }
    case 'swarm': {
      const channel = extractFlag(args, 'channel');
      await postAction(buildAction({ action: 'swarm', channel }));
      break;
    }
    case 'reserve': {
      const reason = extractFlag(args, 'reason');
      const paths = args.filter((a) => !a.startsWith('--'));
      if (paths.length === 0) {
        process.stderr.write('Error: reserve requires one or more paths.\n');
        process.exit(1);
      }
      await postAction(buildAction({ action: 'reserve', paths, reason }));
      break;
    }
    case 'release': {
      const paths = args.filter((a) => !a.startsWith('--'));
      await postAction(
        buildAction({ action: 'release', paths: paths.length > 0 ? paths : undefined })
      );
      break;
    }
    case 'set-status': {
      const message = args.join(' ');
      if (!message) {
        process.stderr.write('Error: set-status requires a message.\n');
        process.exit(1);
      }
      await postAction(buildAction({ action: 'set_status', message }));
      break;
    }
    case 'rename': {
      const name = args[0];
      if (!name) {
        process.stderr.write('Error: rename requires a name.\n');
        process.exit(1);
      }
      await postAction(buildAction({ action: 'rename', name }));
      break;
    }

    // ---- Tasks ----
    case 'task': {
      const sub = args.shift();
      switch (sub) {
        case 'list': {
          await postAction(buildAction({ action: 'task.list' }));
          break;
        }
        case 'ready': {
          await postAction(buildAction({ action: 'task.ready' }));
          break;
        }
        case 'show': {
          const id = args[0];
          if (!id) {
            process.stderr.write('Error: task show requires an id.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.show', id }));
          break;
        }
        case 'create': {
          const title = extractFlag(args, 'title');
          const content = extractFlag(args, 'content');
          const dependsOn = extractFlag(args, 'depends-on');
          if (!title) {
            process.stderr.write('Error: task create requires --title.\n');
            process.exit(1);
          }
          await postAction(
            buildAction({
              action: 'task.create',
              title,
              content: content || undefined,
              dependsOn: dependsOn ? [dependsOn] : undefined,
            })
          );
          break;
        }
        case 'claim': {
          const id = args[0];
          if (!id) {
            process.stderr.write('Error: task claim requires an id.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.claim', id }));
          break;
        }
        case 'unclaim': {
          const id = args[0];
          if (!id) {
            process.stderr.write('Error: task unclaim requires an id.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.unclaim', id }));
          break;
        }
        case 'progress': {
          const id = args[0];
          const message = args.slice(1).join(' ');
          if (!id || !message) {
            process.stderr.write('Error: task progress requires <id> <message>.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.progress', id, message }));
          break;
        }
        case 'done': {
          const id = args[0];
          const summary = args.slice(1).join(' ');
          if (!id || !summary) {
            process.stderr.write('Error: task done requires <id> <summary>.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.done', id, summary }));
          break;
        }
        case 'block': {
          const id = args[0];
          const reason = extractFlag(args, 'reason') || args.slice(1).join(' ');
          if (!id) {
            process.stderr.write('Error: task block requires an id.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.block', id, reason }));
          break;
        }
        case 'unblock': {
          const id = args[0];
          if (!id) {
            process.stderr.write('Error: task unblock requires an id.\n');
            process.exit(1);
          }
          await postAction(buildAction({ action: 'task.unblock', id }));
          break;
        }
        case 'reset': {
          const id = args[0];
          const cascade = extractFlagBool(args, 'cascade');
          if (!id) {
            process.stderr.write('Error: task reset requires an id.\n');
            process.exit(1);
          }
          await postAction(
            buildAction({ action: 'task.reset', id, cascade: cascade || undefined })
          );
          break;
        }
        case 'archive-done': {
          await postAction(buildAction({ action: 'task.archive_done' }));
          break;
        }
        default: {
          process.stderr.write(`Unknown task subcommand: ${sub}\n`);
          process.exit(1);
        }
      }
      break;
    }

    // ---- Spawn ----
    case 'spawn': {
      const sub = args[0];
      if (sub === 'list') {
        await postAction(buildAction({ action: 'spawn.list' }));
      } else if (sub === 'history') {
        await postAction(buildAction({ action: 'spawn.history' }));
      } else if (sub === 'stop') {
        const id = args[1];
        if (!id) {
          process.stderr.write('Error: spawn stop requires an id.\n');
          process.exit(1);
        }
        await postAction(buildAction({ action: 'spawn.stop', id }));
      } else {
        // spawn --role Role "mission text" [--persona "..."] [--task-id task-1] [--name name]
        //      [--agent-file path] [--objective "..."] [--context "..."]
        const role = extractFlag(args, 'role') || extractFlag(args, 'title');
        const persona = extractFlag(args, 'persona');
        const taskId = extractFlag(args, 'task-id');
        const name = extractFlag(args, 'name');
        const agentFile = extractFlag(args, 'agent-file');
        const objective = extractFlag(args, 'objective');
        const context = extractFlag(args, 'context');
        const message = args.filter((a) => !a.startsWith('--')).join(' ');
        if (!message && !agentFile) {
          process.stderr.write('Error: spawn requires mission text or --agent-file.\n');
          process.exit(1);
        }
        await postAction(
          buildAction({
            action: 'spawn',
            role: role || undefined,
            persona: persona || undefined,
            taskId: taskId || undefined,
            name: name || undefined,
            agentFile: agentFile || undefined,
            objective: objective || undefined,
            context: context || undefined,
            message: message || undefined,
          })
        );
      }
      break;
    }

    default: {
      // Check if it's key=value shorthand (backward compat)
      if (rawArgs[0].includes('=')) {
        const params: Record<string, string> = {};
        for (const arg of rawArgs) {
          const eq = arg.indexOf('=');
          if (eq > 0) {
            params[arg.slice(0, eq)] = arg.slice(eq + 1);
          } else if (!params.action) {
            params.action = arg;
          }
        }
        await postAction(JSON.stringify(params));
      } else {
        process.stderr.write(`Unknown command: ${action}. Use --help for usage.\n`);
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  process.stderr.write(`pi-messenger-swarm: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
