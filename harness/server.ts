/**
 * Pi Messenger Harness Server
 *
 * Long-lived HTTP server for action dispatch.
 * Models call `pi-messenger-swarm join` / `pi-messenger-swarm task claim task-1` etc.
 *
 * Multi-agent aware: each request carries an x-caller-pid header
 * (the PID of the calling agent's pi process, discovered by the CLI
 * by walking its own process tree).  The server resolves the correct
 * per-agent state from disk before dispatching.
 *
 * Endpoints (bind 127.0.0.1:9877 by default; override with $PI_MESSENGER_PORT):
 *   POST /action   body = JSON action params (must include `action` field)
 *                  Headers: x-caller-pid, x-messenger-channel
 *                  Response: { ok: true, result: {...} } | { ok: false, error: string }
 *   GET  /health   { ok: true, uptime, agents }
 *   POST /quit     graceful shutdown
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as fs from 'node:fs';
import type { MessengerState, Dirs, AgentMailMessage, NameThemeConfig } from '../lib.js';
import { loadConfig, type MessengerConfig } from '../config.js';
import { executeAction, type RouterConfig } from '../router.js';
import {
  normalizeChannelId,
  ensureDefaultNamedChannels,
  ensureSessionChannel,
  ensureExistingOrCreateChannel,
  getChannelsDir,
  patchChannelSessionId,
} from '../channel.js';
import { ensureDirSync, getGitBranch, normalizeCwd } from '../store/shared.js';

// =============================================================================
// Bootstrap: directories, channels, default config
// =============================================================================

function getMessengerDirs(): Dirs {
  const baseDir =
    process.env.PI_MESSENGER_DIR ||
    (process.env.PI_MESSENGER_GLOBAL === '1'
      ? join(homedir(), '.pi/agent/messenger')
      : join(process.cwd(), '.pi/messenger'));
  return {
    base: baseDir,
    registry: join(baseDir, 'registry'),
  };
}

const dirs = getMessengerDirs();
const config: MessengerConfig = loadConfig(process.cwd());
const nameTheme: NameThemeConfig = { theme: config.nameTheme, customWords: config.nameWords };

// Ensure channel / registry dirs exist
ensureDirSync(dirs.registry);
ensureDirSync(getChannelsDir(dirs));
ensureDefaultNamedChannels(dirs);

const routerConfig: RouterConfig = {
  stuckThreshold: config.stuckThreshold,
  swarmEventsInFeed: config.swarmEventsInFeed,
  nameTheme,
  feedRetention: config.feedRetention,
};

// =============================================================================
// Per-request state resolution
// =============================================================================

interface RegistrationFile {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  currentChannel?: string;
  sessionChannel?: string;
  joinedChannels?: string[];
}

function readRegistrations(): RegistrationFile[] {
  try {
    const files = fs.readdirSync(dirs.registry).filter((f) => f.endsWith('.json'));
    return files
      .map((f) => {
        try {
          return JSON.parse(fs.readFileSync(join(dirs.registry, f), 'utf-8'));
        } catch {
          return null;
        }
      })
      .filter((r): r is RegistrationFile => r !== null);
  } catch {
    return [];
  }
}

/**
 * Build a MessengerState for the requesting agent.
 *
 * Identity resolution strategy (no environment variables needed):
 * 1. If x-caller-pid header is provided, find the registration whose
 *    `pid` field matches.  This is the common path when the CLI runs
 *    inside a pi bash session — the CLI discovers the parent pi process
 *    PID and sends it here.
 * 2. If no caller PID (human terminal, CI, etc.), fall back to:
 *    a. If only one registration on disk → use it (single-agent convenience)
 *    b. If multiple → pick the most recently active by file mtime
 * 3. If no registrations at all, return an unregistered state — the
 *    action handler will reject with "Not registered" if needed, or
 *    the `join` action will register a new agent.
 */
function resolveAgentState(callerPid?: number, channelHint?: string): MessengerState {
  const cwd = normalizeCwd(process.cwd());
  const gitBranch = getGitBranch(cwd);

  let registered = false;
  let resolvedName = '';
  let currentChannel = '';
  let sessionChannel = '';
  let joinedChannels: string[] = [];
  let sessionIdFromDisk = '';

  const regs = readRegistrations();

  // Strategy 1: match by caller PID
  if (callerPid) {
    const match = regs.find((r) => r.pid === callerPid);
    if (match) {
      resolvedName = match.name;
      sessionIdFromDisk = match.sessionId || '';
      currentChannel = match.currentChannel || '';
      sessionChannel = match.sessionChannel || currentChannel;
      joinedChannels = match.joinedChannels || [];
      registered = true;
    }
  }

  // Strategy 2: fallback — single agent or most recently active
  if (!registered && regs.length > 0) {
    if (regs.length === 1) {
      const reg = regs[0];
      resolvedName = reg.name;
      sessionIdFromDisk = reg.sessionId || '';
      currentChannel = reg.currentChannel || '';
      sessionChannel = reg.sessionChannel || currentChannel;
      joinedChannels = reg.joinedChannels || [];
      registered = true;
    } else {
      // Multiple agents, no caller PID — pick most recently active by mtime
      let best: { name: string; mtime: number } | null = null;
      for (const f of fs.readdirSync(dirs.registry).filter((f) => f.endsWith('.json'))) {
        const stat = fs.statSync(join(dirs.registry, f));
        if (!best || stat.mtimeMs > best.mtime) {
          best = { name: f.replace(/\.json$/, ''), mtime: stat.mtimeMs };
        }
      }
      if (best) {
        const reg = regs.find((r) => r.name === best!.name);
        if (reg) {
          resolvedName = reg.name;
          sessionIdFromDisk = reg.sessionId || '';
          currentChannel = reg.currentChannel || '';
          sessionChannel = reg.sessionChannel || currentChannel;
          joinedChannels = reg.joinedChannels || [];
          registered = true;
        }
      }
    }
  }

  // Override channel from request header if provided
  if (channelHint) {
    const record = ensureExistingOrCreateChannel(dirs, channelHint, {
      create: true,
      createdBy: resolvedName || undefined,
    });
    const chId = record?.id ?? normalizeChannelId(channelHint);
    if (!currentChannel) {
      currentChannel = chId;
      sessionChannel = chId;
    }
    if (!joinedChannels.includes(normalizeChannelId(chId))) {
      joinedChannels.push(normalizeChannelId(chId));
    }
  }

  // Resolve session channel if not yet set
  if (!currentChannel && sessionIdFromDisk) {
    const record = ensureSessionChannel(dirs, sessionIdFromDisk, resolvedName || undefined);
    currentChannel = record.id;
    sessionChannel = record.id;
  }

  // Always include memory channel
  const memoryNormalized = normalizeChannelId('memory');
  if (!joinedChannels.includes(memoryNormalized)) {
    joinedChannels.push(memoryNormalized);
  }
  if (currentChannel && !joinedChannels.includes(normalizeChannelId(currentChannel))) {
    joinedChannels.push(normalizeChannelId(currentChannel));
  }

  return {
    agentName: resolvedName,
    registered,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: '',
    gitBranch,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: sessionIdFromDisk,
    callerPid,
    currentChannel,
    sessionChannel,
    joinedChannels,
  };
}

/**
 * Minimal shim for ExtensionContext (harness doesn't have pi's ExtensionAPI).
 */
interface HarnessContext {
  cwd: string;
  hasUI: boolean;
  model: string;
  sessionManager: { getSessionId: () => string };
  ui: {
    theme: { fg: (_color: string, text: string) => string };
    notify: (_msg: string, _type: string) => void;
    setStatus: (_key: string, _text: string) => void;
  };
}

function createHarnessContext(sessionId: string, cwd?: string): HarnessContext {
  return {
    cwd: cwd || normalizeCwd(process.cwd()),
    hasUI: false,
    model: 'harness',
    sessionManager: {
      getSessionId: () => sessionId,
    },
    ui: {
      theme: { fg: (_c: string, t: string) => t },
      notify: () => {},
      setStatus: () => {},
    },
  };
}

// Harness does not deliver messages through pi's ExtensionAPI.
// Feed persistence happens inside the handlers.
// The in-process extension picks up messages via its own delivery mechanism.
const deliverMessage = (_msg: AgentMailMessage): void => {};
const updateStatus = (_ctx: unknown): void => {};

// =============================================================================
// HTTP Server
// =============================================================================

const PORT = Number(process.env.PI_MESSENGER_PORT ?? 9877);
const startedAt = Date.now();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Read an agent-identity header from the request.
 * The CLI forwards these from its own environment.
 */
function header(req: IncomingMessage, name: string): string | undefined {
  const val = req.headers[name.toLowerCase()];
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val[0];
  return undefined;
}

const TEXT_JSON = { 'content-type': 'application/json; charset=utf-8' } as const;
const TEXT_PLAIN = { 'content-type': 'text/plain; charset=utf-8' } as const;

function serverLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  const logPath = process.env.PI_MESSENGER_LOG ?? '/tmp/pi-messenger-swarm.log';
  try {
    fs.appendFileSync(logPath, line);
  } catch {
    // Best effort
  }
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check — report uptime and known agents from disk
  if (req.method === 'GET' && url.pathname === '/health') {
    const agents: string[] = [];
    try {
      for (const f of fs.readdirSync(dirs.registry)) {
        if (f.endsWith('.json')) agents.push(f.replace(/\.json$/, ''));
      }
    } catch {}

    res.writeHead(200, TEXT_JSON);
    res.end(
      JSON.stringify({
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        agents,
        cwd: normalizeCwd(process.cwd()),
      })
    );
    return;
  }

  // Action endpoint
  if (req.method === 'POST' && url.pathname === '/action') {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: 'failed to read body' }));
      return;
    }

    let params: Record<string, unknown>;
    try {
      params = JSON.parse(body);
    } catch {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
      return;
    }

    const action = params.action;
    if (!action || typeof action !== 'string') {
      res.writeHead(400, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: "missing or invalid 'action' field" }));
      return;
    }

    // Resolve agent identity from request headers
    const callerPidStr = header(req, 'x-caller-pid');
    const callerPid = callerPidStr ? parseInt(callerPidStr, 10) : undefined;
    const sessionId = header(req, 'x-session-id');
    const channelHint = header(req, 'x-messenger-channel');

    serverLog(
      `action: ${action} caller_pid: ${callerPid || '(none)'} session: ${sessionId || '(none)'} channel: ${channelHint || '(auto)'}`
    );

    // Build per-request state from disk
    const state = resolveAgentState(callerPid, channelHint);
    // Use session ID from header (written by extension to .pi/messenger/session-id)
    // if available, otherwise fall back to the state's contextSessionId (from disk).
    const effectiveSessionId = sessionId || state.contextSessionId || '';
    const ctx = createHarnessContext(effectiveSessionId, normalizeCwd(process.cwd()));
    // Also update the state's contextSessionId so handlers use it
    state.contextSessionId = effectiveSessionId;

    // If the registration on disk has an empty sessionId but we now have one
    // (from the x-session-id header), patch the registration file so the
    // channel's sessionId and future reads are consistent.
    if (effectiveSessionId && state.registered && state.agentName) {
      const regPath = join(dirs.registry, `${state.agentName}.json`);
      try {
        if (fs.existsSync(regPath)) {
          const reg = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
          if (!reg.sessionId) {
            reg.sessionId = effectiveSessionId;
            fs.writeFileSync(regPath, JSON.stringify(reg, null, 2));
          }
        }
      } catch {
        // Best effort
      }

      // Also patch the session channel's sessionId if it was created before
      // the session-id file was available.
      const ch = state.currentChannel || state.sessionChannel;
      if (ch) {
        try {
          patchChannelSessionId(dirs, ch, effectiveSessionId);
        } catch {
          // Best effort
        }
      }
    }

    try {
      const result = await executeAction(
        action,
        params,
        state,
        dirs,
        ctx as any,
        deliverMessage,
        updateStatus,
        undefined,
        routerConfig
      );

      let text = '';
      let details: Record<string, unknown> = {};

      if (result && typeof result === 'object') {
        if ('content' in result && Array.isArray(result.content)) {
          text = result.content
            .map((c: any) => (typeof c === 'object' && 'text' in c ? c.text : String(c)))
            .join('\n');
        }
        if ('details' in result && typeof result.details === 'object') {
          details = result.details as Record<string, unknown>;
        }
      } else if (typeof result === 'string') {
        text = result;
      }

      res.writeHead(200, TEXT_JSON);
      res.end(JSON.stringify({ ok: true, result: { text, details } }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      serverLog(`error: ${msg}`);
      res.writeHead(500, TEXT_JSON);
      res.end(JSON.stringify({ ok: false, error: msg }));
    }
    return;
  }

  // Graceful shutdown
  if (req.method === 'POST' && url.pathname === '/quit') {
    res.writeHead(200, TEXT_JSON);
    res.end(JSON.stringify({ ok: true }));
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 100);
    return;
  }

  // 404
  res.writeHead(404, TEXT_PLAIN);
  res.end('not found\n');
});

server.listen(PORT, '127.0.0.1', () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  const msg = JSON.stringify({
    ok: true,
    ready: true,
    port: actualPort,
    message: `pi-messenger-swarm harness listening on http://127.0.0.1:${actualPort}`,
  });
  process.stdout.write(msg + '\n');
  serverLog(`harness started on port ${actualPort}`);
});

// Graceful shutdown on signals
const shutdown = (signal: string) => {
  serverLog(`received ${signal}, shutting down`);
  server.close();
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server, dirs, config };
