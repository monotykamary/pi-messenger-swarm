import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { generateMemorableName } from '../lib.js';
import { createProgress, parseJsonlLine, updateProgress } from './progress.js';
import { removeLiveWorker, updateLiveWorker } from './live-progress.js';
import type { SpawnRequest, SpawnedAgent } from './types.js';
import { formatRoleLabel } from './labels.js';
import { loadAgentDefinition } from './agent-loader.js';

interface SpawnRuntime {
  process: ChildProcess;
  record: SpawnedAgent;
  startMs: number;
  stopping: boolean;
  persisted?: boolean;
}

const runtimes = new Map<string, SpawnRuntime>();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_DIR = path.resolve(__dirname, '..');

function spawnLiveKey(id: string): string {
  return `spawn-${id}`;
}

// ============================================================================
// Event-Sourced Persistence (JSONL)
// ============================================================================

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

      // Merge event data with existing agent state
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
    // Use literal block scalar for multiline strings
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `${key}: |\n${indented}`;
  }
  // Simple inline value for single-line strings
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

// ============================================================================
// Prompt Building
// ============================================================================

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

  lines.push(
    '',
    '## Swarm Operating Protocol',
    '1. Join the mesh first: pi_messenger({ action: "join" }).',
    '2. Coordinate via messaging/reservations/task actions before risky edits.',
    '3. Task claiming is required: If assigned a taskId, claim it before beginning work: pi_messenger({ action: "task.claim", id: "<taskId>" }). Failure to claim indicates another agent owns it; report the conflict and await further instruction.',
    '4. Progress updates are required: Update task progress every 3-5 tool calls or at significant milestones: pi_messenger({ action: "task.progress", id: "<taskId>", message: "Specific achievement and rationale" }).',
    '5. Task completion is required: Mark the task done upon mission completion: pi_messenger({ action: "task.done", id: "<taskId>", summary: "Concrete accomplishment with evidence" }).',
    '6. Be concise, evidence-based, and stay in role.',
    '7. Clarify ambiguity early: if mission scope, expected output format, or framing is unclear or seems incomplete, send a brief targeted question via pi_messenger({ action: "send", to: "AgentName", message: "..." }) before proceeding. A 30-second alignment check prevents off-target work.',
    '8. Exit when mission is complete: use bash({ command: "exit 0" }) to self-terminate. Do not stay alive indefinitely.'
  );

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
      `   pi_messenger({ action: "task.claim", id: "${request.taskId}" })`,
      '   If the claim fails, report the conflict and await instruction. Do not proceed with unclaimed work.',
      '',
      '2. Update progress at regular intervals:',
      `   pi_messenger({ action: "task.progress", id: "${request.taskId}", message: "Specific milestone achieved" })`,
      '   Send updates every 3-5 tool calls or upon completing significant milestones. Include what was done and why.',
      '',
      '3. Mark the task done upon completion:',
      `   pi_messenger({ action: "task.done", id: "${request.taskId}", summary: "Concrete accomplishment with evidence" })`,
      '   Provide evidence of completion in the summary.'
    );
  }

  lines.push(
    '',
    '## Definition of Done',
    '- Objective addressed with concrete output.',
    request.taskId ? `- Progress updates recorded via pi_messenger at appropriate intervals.` : '',
    request.taskId ? `- Task marked done via pi_messenger before exit.` : '',
    '- Any file reservations released before exit.',
    '- Exit with: bash({ command: "exit 0" })'
  );

  return lines.join('\n');
}

function upsertSpawnRecord(
  id: string,
  updater: (record: SpawnedAgent) => SpawnedAgent
): SpawnedAgent | null {
  const runtime = runtimes.get(id);
  if (!runtime) return null;
  runtime.record = updater(runtime.record);
  return runtime.record;
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

  if (state.systemPrompt.trim().length > 0) {
    const promptTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-subagent-'));
    const promptPath = path.join(
      promptTmpDir,
      `${state.name.replace(/[^\w.-]/g, '_')}-${state.id}.md`
    );
    fs.writeFileSync(promptPath, state.systemPrompt, { mode: 0o600 });
    args.push('--append-system-prompt', promptPath);
    // Store tmpdir on args for retrieval
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
      });
    }
  });

  proc.stderr?.on('data', (data: Buffer | string) => {
    state.stderr += data.toString();
  });

  proc.on('error', () => {
    cleanupTmpDir(promptTmpDir);
  });

  proc.on('close', (code, signal) => {
    cleanupTmpDir(promptTmpDir);
    removeLiveWorker(state.cwd, state.request.taskId || spawnLiveKey(state.id));

    const runtime = runtimes.get(state.id);
    if (!runtime) return;

    const endedAt = new Date().toISOString();
    let status: SpawnedAgent['status'] = 'completed';
    let eventType: SpawnEvent['type'] = 'completed';

    if (runtime.stopping || signal) {
      // Mark as stopped if explicitly stopped or terminated by signal
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

    // Append completion event (event-sourced persistence)
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

    // Generate reusable agent file
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

  // Determine system prompt and user prompt based on mode
  let systemPrompt: string;
  let prompt: string;
  let role: string;
  let objective: string;
  let agentFileModel: string | undefined;

  if (request.agentFile) {
    // File-based mode: parse frontmatter, use body as system prompt
    const filePath = path.resolve(cwd, request.agentFile);
    const def = loadAgentDefinition(filePath);
    systemPrompt = def.systemPrompt;
    // Use message > objective from call > objective from file
    objective = request.message || request.objective || def.objective || '';
    prompt = objective;
    role = def.role;
    // Extract model from agent file (reserved for agent files only)
    agentFileModel = def.model;
    // Override persona from file if not specified in request
    if (def.persona && !request.persona) {
      request = { ...request, persona: def.persona };
    }
  } else {
    // Autoregressive mode: build prompts from parameters
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

  // Append spawn event (event-sourced persistence)
  appendEvent(cwd, sessionId, {
    id,
    type: 'spawned',
    timestamp: startedAt,
    agent: { ...record },
  });

  // Generate initial agent file (will be updated on exit)
  generateAgentFile(cwd, sessionId, record);

  const env = {
    ...process.env,
    PI_AGENT_NAME: name,
    PI_SWARM_SPAWNED: '1',
    ...(inheritedChannel ? { PI_MESSENGER_CHANNEL: inheritedChannel } : {}),
  };

  const state: SpawnState = {
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

  const args = createArgs(state, agentFileModel);
  const promptTmpDir = (args as any)._promptTmpDir as string | null;

  const proc = spawn('pi', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  attachHandlers(proc, state, promptTmpDir, sessionId);

  runtimes.set(id, {
    process: proc,
    record,
    startMs: state.startMs,
    stopping: false,
  });

  return record;
}

export function listSpawned(
  cwd: string,
  sessionId: string,
  includeAll: boolean = false
): SpawnedAgent[] {
  // First, get persisted agents for this session from event log
  const persisted = loadSpawnedAgents(cwd, sessionId);
  const persistedById = new Map(persisted.map((a) => [a.id, a]));

  // Override with any in-memory runtimes (for running agents with live process handles)
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.sessionId !== sessionId) continue;
    persistedById.set(id, runtime.record);
  }

  let agents = Array.from(persistedById.values());

  // Filter to only running agents by default
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

export function cleanupExitedSpawned(cwd: string, sessionId: string): number {
  // Ensures exited agents are persisted and returns count of newly-finalized agents.
  // With event sourcing, this mainly handles edge cases where the close handler didn't fire.
  let finalized = 0;
  for (const [id, runtime] of runtimes.entries()) {
    if (runtime.record.cwd !== cwd) continue;
    if (runtime.record.sessionId !== sessionId) continue;
    // Only process if process has exited
    if (runtime.process.exitCode === null && runtime.process.signalCode === null) continue;
    // Skip if already persisted (avoid duplicate work)
    if (runtime.persisted) continue;

    // Agent has finished but not yet persisted - finalize it now
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

    // Determine final state
    runtime.record = {
      ...runtime.record,
      status,
      endedAt,
      exitCode: runtime.process.exitCode ?? 1,
    };

    // Append completion event
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

    // Generate agent file
    generateAgentFile(cwd, sessionId, runtime.record);
    finalized++;
  }
  return finalized;
}

export function getRunningSpawnCount(cwd?: string): number {
  let count = 0;
  for (const runtime of runtimes.values()) {
    if (cwd && runtime.record.cwd !== cwd) continue;
    if (runtime.process.exitCode === null && runtime.record.status === 'running') count++;
  }
  return count;
}

export function clearSpawnStateForTests(): void {
  runtimes.clear();
}

// No automatic loading on module init - agents are loaded per-session via listSpawned
