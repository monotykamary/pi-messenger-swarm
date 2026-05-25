import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateMemorableName } from '../lib.js';
import { createProgress, updateProgress } from './progress.js';
import { removeLiveWorker, updateLiveWorker } from './live-progress.js';
import type { SpawnRequest, SpawnedAgent } from './types.js';
import { formatRoleLabel } from './labels.js';
import { loadAgentDefinition } from './agent-loader.js';
import { RpcConnection, type AgentEvent } from './rpc-connection.js';

const AGENT_END_DESPAWN_MS = 10 * 60 * 1000;

interface SpawnRuntime {
  rpc: RpcConnection;
  record: SpawnedAgent;
  startMs: number;
  stopping: boolean;
  persisted?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const runtimes = new Map<string, SpawnRuntime>();

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
 * Events are applied in order, with later events overriding earlier state for the same agent.
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

/**
 * Get the full event history for an agent (for auditing).
 */
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
      if (event.id === agentId) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Format a value for YAML frontmatter. Uses literal block scalar (|) for multiline strings.
 */
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

  if (agent.context) {
    lines.push('', '## Context', agent.context);
  }

  if (agent.error) {
    lines.push('', '## Error', agent.error);
  }

  const filePath = agentFilePath(cwd, sessionId, agent.name, agent.id);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
  return filePath;
}

/**
 * The swarm operating protocol — always appended to every subagent's system prompt.
 * This tells the agent HOW to coordinate (join, claim, progress, done, send).
 * It's orthogonal to WHAT the agent does (its role, objective, file content).
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
    '9. Messages from teammates are pushed to you by the harness — you do not need to poll the feed. When a message arrives, address it before continuing your current task.',
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

  if (request.context?.trim()) {
    lines.push('', '## Context & Constraints', request.context.trim());
  }

  if (request.taskId) {
    lines.push('', '## Assigned Task', `Primary task: ${request.taskId}`);
  }

  lines.push('', buildSwarmProtocol());

  return lines.join('\n');
}

function buildPrompt(request: SpawnRequest): string {
  const objective = (request.objective ?? request.message ?? '').trim();

  const lines: string[] = ['# Mission Brief', '', objective];

  if (request.context?.trim()) {
    lines.push('', '## Additional Context', request.context.trim());
  }

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
      ? `- Progress updates recorded via pi-messenger-swarm at appropriate intervals.`
      : '',
    request.taskId ? `- Task marked done via pi-messenger-swarm before exit.` : '',
    '- All findings and evidence recorded in task progress/done (the coordinator reads output via `pi-messenger-swarm task show`, not your response text).',
    '- Any file reservations released before exit.',
    '- EXIT IMMEDIATELY after task.done: bash({ command: "exit 0" }). Do not idle or monitor after completion.'
  );

  return lines.join('\n');
}

function createRpcArgs(systemPrompt: string, model?: string): string[] {
  const args = ['--mode', 'rpc', '--no-session'];
  if (model) {
    const slash = model.indexOf('/');
    if (slash !== -1) {
      args.push('--provider', model.slice(0, slash), '--model', model.slice(slash + 1));
    } else {
      args.push('--model', model);
    }
  }
  args.push('--extension', EXTENSION_DIR);

  if (systemPrompt.trim().length > 0) {
    const promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-subagent-'));
    const promptPath = path.join(promptTmpDir, 'system-prompt.md');
    fs.writeFileSync(promptPath, systemPrompt, { mode: 0o600 });
    args.push('--append-system-prompt', promptPath);
    // Store tmpdir on args for retrieval
    (args as any)._promptTmpDir = promptTmpDir;
  }

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

function attachRpcHandlers(
  rpc: RpcConnection,
  state: {
    id: string;
    cwd: string;
    name: string;
    taskId?: string;
    startMs: number;
    progress: ReturnType<typeof createProgress>;
  },
  promptTmpDir: string | null,
  sessionId: string
) {
  const runtime = runtimes.get(state.id);

  function clearIdleTimer(): void {
    if (runtime?.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }
  }

  function setAgentEndTimer(): void {
    clearIdleTimer();
    if (!runtime) return;
    runtime.idleTimer = setTimeout(() => {
      if (runtime.rpc.isAlive) {
        appendEvent(state.cwd, sessionId, {
          id: state.id,
          type: 'failed',
          timestamp: new Date().toISOString(),
          agent: {
            status: 'failed',
            endedAt: new Date().toISOString(),
            exitCode: 1,
            error: `Agent did not exit within ${AGENT_END_DESPAWN_MS / 60000} min after agent_end`,
          },
        });
        runtime.rpc.kill();
      }
    }, AGENT_END_DESPAWN_MS);
  }

  // Subscribe to agent events for live progress tracking
  rpc.onEvent((event: AgentEvent) => {
    if (event.type === 'tool_call' || event.type === 'tool_result' || event.type === 'turn_end') {
      updateProgress(state.progress, event, state.startMs);
    }

    if (event.type === 'agent_end') {
      // Agent finished its turn; if it doesn't exit naturally within the
      // grace period, force-kill it to prevent zombies.
      setAgentEndTimer();
    } else {
      // Agent is still working; cancel any pending post-agent_end timer.
      clearIdleTimer();
    }

    updateLiveWorker(state.cwd, state.taskId || spawnLiveKey(state.id), {
      taskId: state.taskId || spawnLiveKey(state.id),
      agent: 'swarm-subagent',
      name: state.name,
      progress: {
        ...state.progress,
        recentTools: state.progress.recentTools.map((tool) => ({ ...tool })),
      },
      startedAt: state.startMs,
    });
  });

  // Handle process exit
  const handleExit = (code: number | null, signal: string | null) => {
    cleanupTmpDir(promptTmpDir);
    removeLiveWorker(state.cwd, state.taskId || spawnLiveKey(state.id));

    const runtime = runtimes.get(state.id);
    if (!runtime) return;

    if (runtime.idleTimer) {
      clearTimeout(runtime.idleTimer);
      runtime.idleTimer = undefined;
    }

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent['status'] = 'completed';
    let eventType: SpawnEvent['type'] = 'completed';

    if (runtime.stopping || (signal !== null && signal !== undefined)) {
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
          ? rpc.collectedStderr.trim() || runtime.record.error || 'subagent failed'
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
    rpc.destroy();
  };

  // Patch the onExit callback on the RpcConnection instance.
  // The 'close' event handler in RpcConnection reads this.onExitCallback
  // at invocation time (late-bound), so we can set it after start().
  (rpc as any).onExitCallback = handleExit;
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
    ...(inheritedChannel ? { PI_MESSENGER_CHANNEL: inheritedChannel } : {}),
  };

  const args = createRpcArgs(systemPrompt, agentFileModel);
  const promptTmpDir = (args as any)._promptTmpDir as string | null;

  const rpc = new RpcConnection();
  rpc.start({
    cwd,
    args,
    env,
  });

  // Persist the child PID for liveness checking after harness restart
  record.pid = rpc.pid;
  appendEvent(cwd, sessionId, {
    id,
    type: 'progress',
    timestamp: startedAt,
    agent: { pid: rpc.pid },
  });

  const progress = createProgress(name);
  const startMs = Date.now();

  attachRpcHandlers(
    rpc,
    { id, cwd, name, taskId: request.taskId, startMs, progress },
    promptTmpDir,
    sessionId
  );

  // Send the initial prompt to get the agent started
  rpc.prompt(prompt).catch(() => {
    // If prompt fails, the error will be caught by exit handlers
  });

  runtimes.set(id, {
    rpc,
    record,
    startMs,
    stopping: false,
  });

  return record;
}

/**
 * Push a message to a running subagent via its RPC connection.
 * Uses steer() to interrupt the agent mid-turn, or followUp() if idle.
 *
 * Returns true if the message was accepted by the RPC channel,
 * false if the agent is not running or the RPC is not connected.
 */
export function steerAgent(id: string, message: string): boolean {
  const runtime = runtimes.get(id);
  if (!runtime) return false;
  if (!runtime.rpc.isAlive) return false;

  runtime.rpc
    .steer(message)
    .then(() => {})
    .catch(() => {
      // steer failure — agent may have already exited
    });
  return true;
}

/**
 * Push a message to a running subagent by name.
 *
 * Convenience wrapper around steerAgent() that resolves by name
 * instead of internal ID. Used by the harness deliverMessage callback
 * which only knows the agent's registered name.
 *
 * Returns true if the message was accepted, false otherwise.
 */
export function steerAgentByName(name: string, message: string): boolean {
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.name === name && runtime.rpc.isAlive) {
      return steerAgent(id, message);
    }
  }
  return false;
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

  if (!includeAll) {
    agents = agents.filter((a) => a.status === 'running');
  }

  return agents.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

/**
 * Get all spawned agents including completed/failed/stopped (history view).
 */
export function listSpawnedHistory(cwd: string, sessionId: string): SpawnedAgent[] {
  return listSpawned(cwd, sessionId, true);
}

/**
 * Find a spawned agent by name (including non-running agents).
 */
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
  if (!runtime.rpc.isAlive) return false;

  if (runtime.idleTimer) {
    clearTimeout(runtime.idleTimer);
    runtime.idleTimer = undefined;
  }

  runtime.stopping = true;
  runtime.rpc.kill();
  return true;
}

export function stopAllSpawned(cwd?: string): void {
  for (const [_id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (!runtime.rpc.isAlive) continue;
    runtime.stopping = true;
    runtime.rpc.kill();
  }
}

/**
 * Force-kill all spawned agents with SIGKILL.
 * Used as a fallback after graceful SIGTERM didn't work in time.
 */
export function forceKillAllSpawned(cwd?: string): void {
  for (const [_id, runtime] of runtimes.entries()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    const proc = (runtime.rpc as any).process;
    if (proc && proc.exitCode === null) {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already dead
      }
    }
  }
}

export function cleanupExitedSpawned(cwd: string, sessionId: string): number {
  let finalized = 0;
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.sessionId !== sessionId) continue;
    if (runtime.rpc.isAlive) continue;
    if (runtime.persisted) continue;

    runtime.persisted = true;

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent['status'] = 'completed';
    let eventType: SpawnEvent['type'] = 'completed';

    if (runtime.stopping) {
      status = 'stopped';
      eventType = 'stopped';
    } else if ((runtime.rpc.exitCode ?? 1) !== 0) {
      status = 'failed';
      eventType = 'failed';
    }

    runtime.record = {
      ...runtime.record,
      status,
      endedAt,
      exitCode: runtime.rpc.exitCode ?? 1,
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

/**
 * Check whether a process is still alive using a zero-signal probe.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reconcile persisted "running" agents against actual process liveness.
 *
 * When the harness server restarts, all in-memory `runtimes` are lost and
 * exit handlers are gone. Any subagent that died while the harness was down
 * stays stuck as "running" in the JSONL event log. This function detects
 * and corrects those orphans by checking PID liveness or a staleness
 * timeout.
 */
export function reconcileSpawnedAgents(cwd: string, sessionId: string): number {
  const persisted = loadSpawnedAgents(cwd, sessionId);
  let reconciled = 0;

  for (const agent of persisted) {
    if (agent.status !== 'running') continue;

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
      continue;
    }

    if (!agent.pid) {
      const runningForMs = Date.now() - Date.parse(agent.startedAt);
      const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;
      if (runningForMs > STALE_THRESHOLD_MS) {
        appendEvent(cwd, sessionId, {
          id: agent.id,
          type: 'failed',
          timestamp: new Date().toISOString(),
          agent: {
            status: 'failed',
            endedAt: new Date().toISOString(),
            exitCode: 1,
            error: 'Agent exceeded staleness threshold (no PID, no completion event)',
          },
        });
        reconciled++;
      }
    }
  }

  return reconciled;
}

export function getRunningSpawnCount(cwd?: string): number {
  let count = 0;
  for (const runtime of runtimes.values()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.rpc.isAlive && runtime.record.status === 'running') count++;
  }
  return count;
}

export function clearSpawnStateForTests(): void {
  runtimes.clear();
}
