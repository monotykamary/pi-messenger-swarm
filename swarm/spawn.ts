import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateMemorableName } from '../lib.js';
import { createProgress, parseJsonlLine, updateProgress } from './progress.js';
import { removeLiveWorker, updateLiveWorker } from './live-progress.js';
import type { SpawnRequest, SpawnedAgent } from './types.js';
import { formatRoleLabel } from './labels.js';
import { loadAgentDefinition } from './agent-loader.js';

const AGENT_END_DESPAWN_MS = 10 * 60 * 1000;

interface SpawnRuntime {
  process: ChildProcess;
  record: SpawnedAgent;
  startMs: number;
  stopping: boolean;
  persisted?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  // Runtime restored from disk after server restart — no ChildProcess handle,
  // just a PID we poll for liveness.
  detached?: boolean;
}

const runtimes = new Map<string, SpawnRuntime>();

// Interval handle for polling detached runtime PIDs
let detachedPollTimer: ReturnType<typeof setInterval> | null = null;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, '..');

function spawnLiveKey(id: string): string {
  return `spawn-${id}`;
}

interface SpawnEvent {
  id: string;
  type: 'spawned' | 'completed' | 'failed' | 'stopped' | 'progress';
  timestamp: string;
  agent: Partial<SpawnedAgent>;
}

function getAgentEventsJsonlPath(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'agents', `${safeSessionId}.jsonl`);
}

function getAgentDefinitionsDir(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'agents', safeSessionId);
}

function agentFilePath(cwd: string, sessionId: string, name: string, id: string): string {
  const safeName = name.replace(/[^\w.-]/g, '_');
  return path.join(getAgentDefinitionsDir(cwd, sessionId), `${safeName}-${id}.md`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function appendEvent(cwd: string, sessionId: string, event: SpawnEvent): void {
  const filePath = getAgentEventsJsonlPath(cwd, sessionId);
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
}

/**
 * Replay events to build current state of all agents.
 */
export function loadSpawnedAgents(cwd: string, sessionId: string): SpawnedAgent[] {
  const filePath = getAgentEventsJsonlPath(cwd, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const agentsById = new Map<string, SpawnedAgent>();

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SpawnEvent;
      const existing = agentsById.get(event.id);
      const merged: SpawnedAgent = existing
        ? { ...existing, ...event.agent, id: event.id }
        : { ...(event.agent as SpawnedAgent), id: event.id };
      agentsById.set(event.id, merged);
    } catch {
      // Skip malformed lines
    }
  }

  return Array.from(agentsById.values()).sort(
    (a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)
  );
}

export function getAgentEventHistory(
  cwd: string,
  sessionId: string,
  agentId: string
): SpawnEvent[] {
  const filePath = getAgentEventsJsonlPath(cwd, sessionId);
  if (!fs.existsSync(filePath)) return [];

  const events: SpawnEvent[] = [];
  const content = fs.readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SpawnEvent;
      if (event.id === agentId) events.push(event);
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

function formatYamlMultiline(key: string, value: string): string {
  if (value.includes('\n')) {
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `${key}: |\n${indented}`;
  }
  return `${key}: ${value}`;
}

function generateAgentFile(cwd: string, sessionId: string, agent: SpawnedAgent): string | null {
  if (!agent.systemPrompt) return null;

  const lines: string[] = [
    '---',
    `role: ${agent.role}`,
    ...(agent.model ? [`model: ${agent.model}`] : []),
    ...(agent.persona ? [formatYamlMultiline('persona', agent.persona)] : []),
    ...(agent.objective ? [formatYamlMultiline('objective', agent.objective)] : []),
    `created: ${agent.startedAt}`,
    `status: ${agent.status}`,
    ...(agent.endedAt ? [`ended: ${agent.endedAt}`] : []),
    ...(agent.exitCode !== undefined ? [`exitCode: ${agent.exitCode}`] : []),
    ...(agent.pid ? [`pid: ${agent.pid}`] : []),
    ...(agent.taskId ? [`taskId: ${agent.taskId}`] : []),
    '---',
    '',
    agent.systemPrompt,
  ];

  if (agent.context) lines.push('', '## Context', agent.context);
  if (agent.error) lines.push('', '## Error', agent.error);

  const filePath = agentFilePath(cwd, sessionId, agent.name, agent.id);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

/**
 * The swarm operating protocol — always appended to every subagent's system prompt.
 * Pull-based: agents read the feed themselves. No RPC push.
 */
function buildSwarmProtocol(): string {
  return [
    '## Swarm Operating Protocol',
    '1. Join the mesh first: `pi-messenger-swarm join`.',
    '2. Coordinate via messaging/reservations/task actions before risky edits.',
    '3. Task claiming is required: If assigned a taskId, claim it before beginning work: `pi-messenger-swarm task claim <taskId>`. Failure to claim indicates another agent owns it; report the conflict and await further instruction.',
    '4. You were spawned by a coordinator agent. That agent delegated this task to you — it will NOT claim or implement this task itself. You own it.',
    '5. Progress updates are required: Update task progress every 3-5 tool calls or at significant milestones: `pi-messenger-swarm task progress <taskId> "Specific achievement and rationale"`.',
    '6. Task completion is required: Mark the task done upon mission completion: `pi-messenger-swarm task done <taskId> "Concrete accomplishment with evidence"`.',
    '6.5 Report findings IN the task.done summary or task.progress messages — not just in your response text. The coordinator reads your output via `pi-messenger-swarm task show <taskId>`, so all findings must be in the task record. The feed only shows one-line previews.',
    '7. Be concise, evidence-based, and stay in role.',
    '8. Clarify ambiguity early: if mission scope, expected output format, or framing is unclear or seems incomplete, send a brief targeted question via `pi-messenger-swarm send AgentName "..."` before proceeding. A 30-second alignment check prevents off-target work.',
    '9. Check channel feed between turns: `pi-messenger-swarm feed --limit 10`. If a teammate sent you a message, respond before proceeding. Messages are channel-mediated — reading the feed is required to receive them. This is pull-based: nobody pushes messages to you.',
    '10. Exit immediately after marking task done: `bash({ command: "exit 0" })`. Do not stay alive after your mission is complete. Do not monitor the feed, wait for messages, or idle. Once you have called `pi-messenger-swarm task done`, you are done — exit right after. Remaining alive wastes resources and signals incomplete work.',
  ].join('\n');
}

function buildSystemPrompt(request: SpawnRequest): string {
  const role = formatRoleLabel(request.role ?? 'Subagent');
  const persona = request.persona?.trim();
  const objective = (request.objective ?? request.message ?? '').trim();

  const lines: string[] = [
    '# Swarm Subagent Role',
    '',
    '## Role Description',
    `You are a specialized ${role} operating as an autonomous subagent inside a collaborative swarm.`,
  ];

  if (persona) {
    lines.push(`Persona: ${persona}`);
    lines.push('Stay consistent with this persona in tone, prioritization, and decision-making.');
  }

  lines.push('', '## Mission Focus', objective);

  if (request.context?.trim()) lines.push('', '## Context & Constraints', request.context.trim());

  if (request.taskId) lines.push('', '## Assigned Task', `Primary task: ${request.taskId}`);

  lines.push('', buildSwarmProtocol());

  return lines.join('\n');
}

function buildPrompt(request: SpawnRequest): string {
  const objective = (request.objective ?? request.message ?? '').trim();
  const lines: string[] = ['# Mission Brief', '', objective];

  if (request.context?.trim()) lines.push('', '## Additional Context', request.context.trim());

  if (request.taskId) {
    lines.push(
      '',
      '## Task Execution Procedure',
      'Follow this sequence when executing an assigned task:',
      '',
      '1. Claim the task before starting:',
      `   pi-messenger-swarm task claim ${request.taskId}`,
      '   If the claim fails, report the conflict and await instruction. Do not proceed with unclaimed work.',
      '',
      '2. Update progress at regular intervals:',
      `   pi-messenger-swarm task progress ${request.taskId} "Specific milestone achieved"`,
      '   Send updates every 3-5 tool calls or upon completing significant milestones. Include what was done and why.',
      '',
      '3. Mark the task done upon completion:',
      `   pi-messenger-swarm task done ${request.taskId} "Concrete accomplishment with evidence"`,
      '   Provide evidence of completion in the summary.'
    );
  }

  lines.push(
    '',
    '## Definition of Done',
    '- Objective addressed with concrete output.',
    request.taskId
      ? '- Progress updates recorded via pi-messenger-swarm at appropriate intervals.'
      : '',
    request.taskId ? '- Task marked done via pi-messenger-swarm before exit.' : '',
    '- All findings and evidence recorded in task progress/done (the coordinator reads output via `pi-messenger-swarm task show`, not your response text).',
    '- Any file reservations released before exit.',
    '- EXIT IMMEDIATELY after task.done: bash({ command: "exit 0" }). Do not idle or monitor after completion.'
  );

  return lines.join('\n');
}

interface SpawnState {
  id: string;
  cwd: string;
  name: string;
  request: SpawnRequest;
  prompt: string;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  progress: ReturnType<typeof createProgress>;
  startMs: number;
  buffer: string;
  stderr: string;
}

function discoverSkills(cwd: string): string[] {
  const skillPaths: string[] = [];

  // Resolve the agent config directory (~/.pi/agent or PI_CODING_AGENT_DIR)
  const agentDir = process.env.PI_CODING_AGENT_DIR
    ? resolveTildePath(process.env.PI_CODING_AGENT_DIR)
    : path.join(os.homedir(), '.pi', 'agent');
  const userSkillsDir = path.join(agentDir, 'skills');
  const projectSkillsDir = path.join(cwd, '.pi', 'skills');

  for (const dir of [userSkillsDir, projectSkillsDir]) {
    if (!fs.existsSync(dir)) continue;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          skillPaths.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Best effort — skip unreadable directories
    }
  }

  return skillPaths;
}

function resolveTildePath(p: string): string {
  if (p.startsWith('~/')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function createArgs(state: SpawnState, model?: string): string[] {
  const args = ['--mode', 'json', '--no-session'];
  if (model) {
    const slash = model.indexOf('/');
    if (slash !== -1) {
      args.push('--provider', model.slice(0, slash), '--model', model.slice(slash + 1));
    } else {
      args.push('--model', model);
    }
  }
  args.push('--extension', EXTENSION_DIR);

  // Inherit non-extension skills so spawned agents can use cdp, zele, etc.
  for (const skillPath of discoverSkills(state.cwd)) {
    args.push('--skill', skillPath);
  }

  if (state.systemPrompt.trim().length > 0) {
    const promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-subagent-'));
    const promptPath = path.join(
      promptTmpDir,
      `${state.name.replace(/[^\w.-]/g, '_')}-${state.id}.md`
    );
    fs.writeFileSync(promptPath, state.systemPrompt, { mode: 0o600 });
    args.push('--append-system-prompt', promptPath);
    (args as any)._promptTmpDir = promptTmpDir;
  }

  args.push(state.prompt);
  return args;
}

function cleanupTmpDir(tmpDir: string | null) {
  if (!tmpDir) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}

function attachHandlers(
  proc: ChildProcess,
  state: SpawnState,
  promptTmpDir: string | null,
  sessionId: string
) {
  proc.stdout?.on('data', (data: Buffer | string) => {
    state.buffer += data.toString();
    const lines = state.buffer.split('\n');
    state.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const event = parseJsonlLine(line);
      if (!event) continue;
      updateProgress(state.progress, event, state.startMs);
      updateLiveWorker(state.cwd, state.request.taskId || spawnLiveKey(state.id), {
        taskId: state.request.taskId || spawnLiveKey(state.id),
        agent: 'swarm-subagent',
        name: state.name,
        progress: {
          ...state.progress,
          recentTools: state.progress.recentTools.map((tool) => ({ ...tool })),
        },
        startedAt: state.startMs,
        pid: proc.pid,
      });
    }
  });

  proc.stderr?.on('data', (data: Buffer | string) => {
    state.stderr += data.toString();
  });

  proc.on('error', (err) => {
    cleanupTmpDir(promptTmpDir);
    const runtime = runtimes.get(state.id);
    if (!runtime) return;

    runtime.record = {
      ...runtime.record,
      status: 'failed',
      endedAt: new Date().toISOString(),
      exitCode: 1,
      error: err.message || 'spawn failed',
    };
    runtime.persisted = true;
    appendEvent(state.cwd, sessionId, {
      id: state.id,
      type: 'failed',
      timestamp: runtime.record.endedAt!,
      agent: {
        status: 'failed',
        endedAt: runtime.record.endedAt,
        exitCode: 1,
        error: runtime.record.error,
      },
    });
    generateAgentFile(state.cwd, sessionId, runtime.record);
  });

  proc.on('close', (code, signal) => {
    cleanupTmpDir(promptTmpDir);
    removeLiveWorker(state.cwd, state.request.taskId || spawnLiveKey(state.id));

    const runtime = runtimes.get(state.id);
    if (!runtime) return;

    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent['status'] = 'completed';
    let eventType: SpawnEvent['type'] = 'completed';

    if (runtime.stopping || signal) {
      status = 'stopped';
      eventType = 'stopped';
    } else if ((code ?? 1) !== 0) {
      status = 'failed';
      eventType = 'failed';
    }

    runtime.record = {
      ...runtime.record,
      status,
      endedAt,
      exitCode: code ?? (signal ? 1 : undefined),
      error:
        status === 'failed'
          ? state.stderr.trim() || runtime.record.error || 'subagent failed'
          : undefined,
    };

    runtime.persisted = true;
    appendEvent(state.cwd, sessionId, {
      id: state.id,
      type: eventType,
      timestamp: endedAt,
      agent: {
        status,
        endedAt,
        exitCode: runtime.record.exitCode,
        error: runtime.record.error,
      },
    });

    generateAgentFile(state.cwd, sessionId, runtime.record);
  });
}

export function spawnSubagent(
  cwd: string,
  request: SpawnRequest,
  sessionId: string,
  inheritedChannel?: string
): SpawnedAgent {
  const id = randomUUID().slice(0, 8);
  const name = request.name?.trim() || generateMemorableName();
  const startedAt = new Date().toISOString();

  let systemPrompt: string;
  let prompt: string;
  let role: string;
  let objective: string;
  let agentFileModel: string | undefined;

  if (request.agentFile) {
    const filePath = path.resolve(cwd, request.agentFile);
    const def = loadAgentDefinition(filePath);
    systemPrompt = def.systemPrompt + '\n\n' + buildSwarmProtocol();
    objective = request.message || request.objective || def.objective || '';
    prompt = objective;
    role = def.role;
    agentFileModel = def.model;
    if (def.persona && !request.persona) {
      request = { ...request, persona: def.persona };
    }
  } else {
    systemPrompt = buildSystemPrompt(request);
    prompt = buildPrompt(request);
    role = request.role || 'Subagent';
    objective = request.objective || request.message || '';
  }

  const record: SpawnedAgent = {
    id,
    cwd,
    name,
    role,
    model: agentFileModel,
    persona: request.persona,
    objective,
    context: request.context,
    taskId: request.taskId,
    status: 'running',
    startedAt,
    sessionId,
  };
  record.systemPrompt = systemPrompt;

  appendEvent(cwd, sessionId, {
    id,
    type: 'spawned',
    timestamp: startedAt,
    agent: { ...record },
  });

  generateAgentFile(cwd, sessionId, record);

  const env = {
    ...process.env,
    PI_SWARM_SPAWNED: '1',
    PI_AGENT_NAME: name,
    ...(inheritedChannel ? { PI_MESSENGER_CHANNEL: inheritedChannel } : {}),
  };

  const spawnState: SpawnState = {
    id,
    cwd,
    name,
    request,
    prompt,
    systemPrompt,
    env,
    progress: createProgress(name),
    startMs: Date.now(),
    buffer: '',
    stderr: '',
  };

  const args = createArgs(spawnState, agentFileModel);
  const promptTmpDir = (args as any)._promptTmpDir as string | null;

  const proc = spawn('pi', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  record.pid = proc.pid;
  appendEvent(cwd, sessionId, {
    id,
    type: 'progress',
    timestamp: startedAt,
    agent: { pid: proc.pid },
  });

  attachHandlers(proc, spawnState, promptTmpDir, sessionId);

  runtimes.set(id, {
    process: proc,
    record,
    startMs: spawnState.startMs,
    stopping: false,
  });

  return record;
}

export function listSpawned(
  cwd: string,
  sessionId: string,
  includeAll: boolean = false
): SpawnedAgent[] {
  const persisted = loadSpawnedAgents(cwd, sessionId);
  const persistedById = new Map(persisted.map((a) => [a.id, a]));

  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.sessionId !== sessionId) continue;
    persistedById.set(id, runtime.record);
  }

  let agents = Array.from(persistedById.values());
  if (!includeAll) agents = agents.filter((a) => a.status === 'running');

  return agents.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

export function listSpawnedHistory(cwd: string, sessionId: string): SpawnedAgent[] {
  return listSpawned(cwd, sessionId, true);
}

export function findSpawnedAgentByName(
  cwd: string,
  sessionId: string,
  name: string
): SpawnedAgent | null {
  const allAgents = listSpawnedHistory(cwd, sessionId);
  return allAgents.find((a) => a.name === name) ?? null;
}

export function stopSpawn(cwd: string, id: string): boolean {
  const runtime = runtimes.get(id);
  if (!runtime) return false;
  if (runtime.record.cwd !== cwd) return false;
  // Detached runtimes use PID liveness checks
  if (runtime.detached) {
    if (runtime.record.pid && isProcessAlive(runtime.record.pid)) {
      runtime.stopping = true;
      try {
        process.kill(runtime.record.pid, 'SIGTERM');
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          if (isProcessAlive(runtime.record.pid!)) process.kill(runtime.record.pid!, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }, 4000).unref();
      return true;
    }
    return false;
  }
  if (runtime.process.exitCode !== null) return false;

  runtime.stopping = true;
  runtime.process.kill('SIGTERM');
  setTimeout(() => {
    if (runtime.process.exitCode === null) {
      runtime.process.kill('SIGKILL');
    }
  }, 4000).unref();

  return true;
}

export function stopAllSpawned(cwd?: string): void {
  for (const [id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.detached) {
      if (runtime.record.pid && isProcessAlive(runtime.record.pid)) {
        runtime.stopping = true;
        try {
          process.kill(runtime.record.pid, 'SIGTERM');
        } catch {
          /* already dead */
        }
        const pid = runtime.record.pid;
        setTimeout(() => {
          try {
            if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }, 4000).unref();
      }
      continue;
    }
    if (runtime.process.exitCode !== null) continue;
    runtime.stopping = true;
    runtime.process.kill('SIGTERM');
    setTimeout(() => {
      const live = runtimes.get(id);
      if (!live) return;
      if (live.process.exitCode === null) {
        live.process.kill('SIGKILL');
      }
    }, 4000).unref();
  }
}

export function forceKillAllSpawned(cwd?: string): void {
  for (const [_id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.detached) {
      if (runtime.record.pid && isProcessAlive(runtime.record.pid)) {
        try {
          process.kill(runtime.record.pid, 'SIGKILL');
        } catch {
          /* already dead */
        }
      }
      continue;
    }
    if (runtime.process.exitCode !== null) continue;
    try {
      runtime.process.kill('SIGKILL');
    } catch {
      // Already dead
    }
  }
}

export function cleanupExitedSpawned(cwd: string, sessionId: string): number {
  let finalized = 0;
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.sessionId !== sessionId) continue;
    if (runtime.persisted) continue;
    // Detached runtimes are handled by the PID polling loop
    if (runtime.detached) continue;
    if (runtime.process.exitCode === null && runtime.process.signalCode === null) continue;

    runtime.persisted = true;

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent['status'] = 'completed';
    let eventType: SpawnEvent['type'] = 'completed';

    if (runtime.stopping) {
      status = 'stopped';
      eventType = 'stopped';
    } else if ((runtime.process.exitCode ?? 1) !== 0) {
      status = 'failed';
      eventType = 'failed';
    }

    runtime.record = {
      ...runtime.record,
      status,
      endedAt,
      exitCode: runtime.process.exitCode ?? 1,
    };

    appendEvent(cwd, sessionId, {
      id,
      type: eventType,
      timestamp: endedAt,
      agent: {
        status,
        endedAt,
        exitCode: runtime.record.exitCode,
      },
    });

    generateAgentFile(cwd, sessionId, runtime.record);
    finalized++;
  }
  return finalized;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function reconcileSpawnedAgents(cwd: string, sessionId: string): number {
  const persisted = loadSpawnedAgents(cwd, sessionId);
  let reconciled = 0;

  for (const agent of persisted) {
    if (agent.status !== 'running') continue;

    // JSON-mode spawns always have a PID; process.exit handles the normal path.
    // This covers harness crash-restart: agent process already exited but the
    // close handler never fired because runtimes was lost.
    if (agent.pid && !isProcessAlive(agent.pid)) {
      appendEvent(cwd, sessionId, {
        id: agent.id,
        type: 'failed',
        timestamp: new Date().toISOString(),
        agent: {
          status: 'failed',
          endedAt: new Date().toISOString(),
          exitCode: 1,
          error: 'Process exited (detected by PID liveness check)',
        },
      });
      reconciled++;
    }
  }

  return reconciled;
}

export function getRunningSpawnCount(cwd?: string): number {
  let count = 0;
  for (const runtime of runtimes.values()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.record.status !== 'running') continue;
    if (runtime.detached) {
      // Detached runtimes are tracked by PID liveness
      if (runtime.record.pid && isProcessAlive(runtime.record.pid)) count++;
    } else if (runtime.process.exitCode === null) {
      count++;
    }
  }
  return count;
}

export function clearSpawnStateForTests(): void {
  runtimes.clear();
  if (detachedPollTimer) {
    clearInterval(detachedPollTimer);
    detachedPollTimer = null;
  }
}

// Persist active runtimes to a single file in the server's messenger
// directory so a restarted harness server can reconnect to surviving
// spawned agents. Only runtimes with a known PID and 'running' status
// are persisted.
//
// All entries go to a single file (not per-project) because the harness
// server handles multiple projects and the new server instance needs to
// find all runtimes from one known location on startup.
function getRuntimesFilePath(messengerDir: string): string {
  return path.join(messengerDir, 'spawn-runtimes.json');
}

export function persistRuntimes(messengerDir: string): void {
  const entries: Array<{
    id: string;
    pid: number;
    record: SpawnedAgent;
    startMs: number;
  }> = [];

  for (const [id, runtime] of runtimes.entries()) {
    // Only persist runtimes that are still running and have a PID
    if (runtime.record.status !== 'running') continue;
    if (!runtime.record.pid) continue;
    // Skip already-dead processes
    if (!runtime.detached && runtime.process.exitCode !== null) continue;
    entries.push({
      id,
      pid: runtime.record.pid!,
      record: { ...runtime.record },
      startMs: runtime.startMs,
    });
  }

  if (entries.length === 0) {
    // Clean up the file if no runtimes need persisting
    clearPersistedRuntimes(messengerDir);
    return;
  }

  const filePath = getRuntimesFilePath(messengerDir);
  try {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf-8');
  } catch {
    // Best effort
  }
}

/**
 * Restore runtimes from a previous server instance. Creates lightweight
 * "detached" runtime entries that monitor PID liveness instead of relying
 * on ChildProcess events.
 */
export function restoreRuntimes(messengerDir: string): number {
  const filePath = getRuntimesFilePath(messengerDir);
  if (!fs.existsSync(filePath)) return 0;

  let entries: Array<{
    id: string;
    pid: number;
    record: SpawnedAgent;
    startMs: number;
  }>;

  try {
    entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!Array.isArray(entries)) return 0;
  } catch {
    return 0;
  }

  const count = restoreRuntimeEntries(entries);
  if (count > 0) startDetachedPolling();
  return count;
}

/**
 * Reconnect orphaned agents found in the event log whose processes are
 * still alive. This handles the crash case: the server died without
 * calling persistRuntimes(), so no spawn-runtimes.json exists, but agent
 * processes are still running.
 *
 * Scans each session's events jsonl for agents with status 'running'
 * and reattaches to those with live PIDs.
 */
export function reconcileAndRestoreOrphans(messengerDir: string): number {
  const agentsDir = path.join(messengerDir, 'agents');
  if (!fs.existsSync(agentsDir)) return 0;

  let jsonlFiles: string[];
  try {
    jsonlFiles = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }

  // Collect orphans from all session event logs
  const entries: Array<{
    id: string;
    pid: number;
    record: SpawnedAgent;
    startMs: number;
  }> = [];

  for (const jsonlFile of jsonlFiles) {
    const filePath = path.join(agentsDir, jsonlFile);
    const agents = loadSpawnedAgentsFromFile(filePath);
    for (const agent of agents) {
      // Skip if already known (restored from spawn-runtimes.json or already tracked)
      if (runtimes.has(agent.id)) continue;
      if (agent.status !== 'running') continue;
      if (!agent.pid) continue;
      if (!isProcessAlive(agent.pid)) {
        // Agent's event log says running but the process is dead.
        // Write the tombstone so the event log is consistent.
        const sessionId = jsonlFile.replace(/\.jsonl$/, '');
        appendEvent(agent.cwd, sessionId, {
          id: agent.id,
          type: 'failed',
          timestamp: new Date().toISOString(),
          agent: {
            status: 'failed',
            endedAt: new Date().toISOString(),
            exitCode: 1,
            error: 'Process exited (detected by orphan reconciliation on server startup)',
          },
        });
        continue;
      }
      entries.push({
        id: agent.id,
        pid: agent.pid!,
        record: agent,
        startMs: Date.parse(agent.startedAt) || Date.now(),
      });
    }
  }

  if (entries.length === 0) return 0;

  const count = restoreRuntimeEntries(entries);
  if (count > 0) startDetachedPolling();
  return count;
}

function restoreRuntimeEntries(
  entries: Array<{
    id: string;
    pid: number;
    record: SpawnedAgent;
    startMs: number;
  }>
): number {
  let restored = 0;
  for (const entry of entries) {
    // Skip if already tracked (e.g., same server re-read)
    if (runtimes.has(entry.id)) continue;

    // Only restore if the process is still alive
    if (!isProcessAlive(entry.pid)) continue;

    // Create a dummy ChildProcess-like object for the detached runtime.
    // We can't re-attach to the real process, but we need something that
    // satisfies the SpawnRuntime interface without crashing on property reads.
    const fakeProcess = {
      pid: entry.pid,
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill: (sig?: string) => {
        try {
          process.kill(entry.pid, sig as any);
        } catch {
          /* already dead */
        }
        return true;
      },
      on: () => fakeProcess as any,
      off: () => fakeProcess as any,
      once: () => fakeProcess as any,
      removeAllListeners: () => fakeProcess as any,
      stdout: null as any,
      stderr: null as any,
      stdin: null as any,
    } as unknown as ChildProcess;

    runtimes.set(entry.id, {
      process: fakeProcess,
      record: entry.record,
      startMs: entry.startMs,
      stopping: false,
      detached: true,
    });
    restored++;
  }

  return restored;
}

/**
 * Load spawned agents from a specific jsonl file (not per-session lookup).
 */
function loadSpawnedAgentsFromFile(filePath: string): SpawnedAgent[] {
  if (!fs.existsSync(filePath)) return [];

  const agentsById = new Map<string, SpawnedAgent>();

  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as SpawnEvent;
      const existing = agentsById.get(event.id);
      const merged: SpawnedAgent = existing
        ? { ...existing, ...event.agent, id: event.id }
        : { ...(event.agent as SpawnedAgent), id: event.id };
      agentsById.set(event.id, merged);
    } catch {
      // Skip malformed lines
    }
  }

  return Array.from(agentsById.values());
}

function startDetachedPolling(): void {
  if (detachedPollTimer) return;
  detachedPollTimer = setInterval(() => {
    for (const [id, runtime] of runtimes.entries()) {
      if (!runtime.detached) continue;
      if (runtime.record.status !== 'running') continue;
      if (!runtime.record.pid) continue;

      if (!isProcessAlive(runtime.record.pid)) {
        // Process died — check if a terminal event already exists in the
        // jsonl (written by the old server's close handler before it exited).
        // This prevents writing a duplicate 'failed' event that would
        // override a legitimate 'completed' event.
        const sessionId = runtime.record.sessionId || '';
        let alreadyFinalized = false;
        if (sessionId) {
          const jsonlPath = getAgentEventsJsonlPath(runtime.record.cwd, sessionId);
          const existingAgents = loadSpawnedAgentsFromFile(jsonlPath);
          const existing = existingAgents.find((a) => a.id === id);
          if (existing && existing.status !== 'running') {
            // Already has a terminal event from the old server — adopt it
            runtime.record = { ...runtime.record, ...existing, id };
            runtime.persisted = true;
            alreadyFinalized = true;
          }
        }

        if (!alreadyFinalized) {
          // No prior terminal event — write our own
          runtime.record = {
            ...runtime.record,
            status: 'failed',
            endedAt: new Date().toISOString(),
            exitCode: 1,
            error: 'Process exited (detected by detached runtime poll)',
          };
          runtime.persisted = true;

          if (sessionId) {
            appendEvent(runtime.record.cwd, sessionId, {
              id,
              type: 'failed',
              timestamp: runtime.record.endedAt!,
              agent: {
                status: 'failed',
                endedAt: runtime.record.endedAt,
                exitCode: 1,
                error: runtime.record.error,
              },
            });
            generateAgentFile(runtime.record.cwd, sessionId, runtime.record);
          }
        }

        removeLiveWorker(runtime.record.cwd, runtime.record.taskId || spawnLiveKey(id));
      }
    }

    // Stop polling if no detached runtimes remain
    const hasDetached = Array.from(runtimes.values()).some(
      (r) => r.detached && r.record.status === 'running'
    );
    if (!hasDetached && detachedPollTimer) {
      clearInterval(detachedPollTimer);
      detachedPollTimer = null;
    }
  }, 5000).unref();
}

/**
 * Remove the persisted runtimes file after a successful restore so a
 * subsequent server start doesn't re-restore stale entries.
 */
export function clearPersistedRuntimes(messengerDir: string): void {
  const filePath = getRuntimesFilePath(messengerDir);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Best effort
  }
}
