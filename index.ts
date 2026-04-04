/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination - no daemon required.
 */

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { OverlayHandle, TUI } from '@mariozechner/pi-tui';
import { truncateToWidth } from '@mariozechner/pi-tui';
import { Type, type TUnsafe } from '@sinclair/typebox';

function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] }
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: 'string',
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
import {
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  formatRelativeTime,
  stripAnsiCodes,
  extractFolder,
} from './lib.js';
import { displayChannelLabel } from './channel.js';
import * as store from './store.js';
import * as handlers from './handlers.js';
import { MessengerOverlay, type OverlayCallbacks } from './overlay.js';
import { MessengerConfigOverlay } from './config-overlay.js';
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from './config.js';
import { executeAction } from './router.js';
import { logFeedEvent, pruneFeed } from './feed.js';
import type { MessengerActionParams } from './action-types.js';
import * as swarmStore from './swarm/store.js';
import { runLegacyAgentCleanup } from './migrations/legacy-agents.js';
import { onLiveWorkersChanged } from './swarm/live-progress.js';
import { stopAllSpawned } from './swarm/spawn.js';
import { createDeliverMessage } from './extension/deliver-message.js';
import { createStatusController } from './extension/status.js';
import { createActivityTracker } from './extension/activity.js';

let overlayTui: TUI | null = null;
let overlayHandle: OverlayHandle | null = null;
let overlayOpening = false;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // One-time migration: remove stale legacy agent markdown files from ~/.pi/agent/agents/
  runLegacyAgentCleanup();

  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: process.env.PI_AGENT_NAME || '',
    registered: false,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: '',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: config.scopeToFolder,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: undefined,
    currentChannel: '',
    sessionChannel: '',
    joinedChannels: [],
  };

  const nameTheme = { theme: config.nameTheme, customWords: config.nameWords };

  // ===========================================================================
  // Directory setup (project-scoped by default)
  // ===========================================================================
  // Note: This runs at extension load time with process.cwd().
  // The actual project path is set correctly when pi starts in a project.
  function getMessengerDirs(): Dirs {
    // Priority: PI_MESSENGER_DIR > project-scoped (default) > global (legacy)
    const baseDir =
      process.env.PI_MESSENGER_DIR ||
      (process.env.PI_MESSENGER_GLOBAL === '1'
        ? join(homedir(), '.pi/agent/messenger') // Legacy global mode
        : join(process.cwd(), '.pi/messenger')); // Project-scoped (default)
    return {
      base: baseDir,
      registry: join(baseDir, 'registry'),
      inbox: join(baseDir, 'inbox'),
    };
  }
  const dirs = getMessengerDirs();

  const deliverMessage = createDeliverMessage({
    pi,
    state,
    dirs,
    config,
    requestRender: () => overlayTui?.requestRender(),
  });

  const { updateStatus, clearAllUnreadCounts, resetChannelScopedUiState } = createStatusController({
    state,
    dirs,
    config,
    maybeAutoOpenSwarmOverlay,
  });

  function syncContextSession(ctx: ExtensionContext): void {
    if (!state.registered) return;

    const rebound = store.rebindContextSession(state, dirs, ctx);
    if (!rebound.changed) return;

    const cwd = ctx.cwd ?? process.cwd();
    if (rebound.previousSessionChannel && rebound.previousSessionChannel !== state.sessionChannel) {
      logFeedEvent(
        cwd,
        state.agentName,
        'leave',
        undefined,
        undefined,
        rebound.previousSessionChannel
      );
    }

    store.stopWatcher(state);
    resetChannelScopedUiState();
    state.watcherRetries = 0;
    store.startWatcher(state, dirs, deliverMessage);
    logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
    overlayTui?.requestRender();
    updateStatus(ctx);
  }

  const STATUS_HEARTBEAT_MS = 15_000;
  let latestCtx: ExtensionContext | null = null;
  let statusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function startStatusHeartbeat(): void {
    if (statusHeartbeatTimer) return;
    statusHeartbeatTimer = setInterval(() => {
      if (latestCtx) updateStatus(latestCtx);
    }, STATUS_HEARTBEAT_MS);
  }

  function stopStatusHeartbeat(): void {
    if (!statusHeartbeatTimer) return;
    clearInterval(statusHeartbeatTimer);
    statusHeartbeatTimer = null;
  }

  onLiveWorkersChanged(() => {
    if (latestCtx) updateStatus(latestCtx);
  });

  // ===========================================================================
  // Registration Context
  // ===========================================================================

  function sendRegistrationContext(ctx: ExtensionContext): void {
    const folder = extractFolder(process.cwd());
    const locationPart = state.gitBranch ? `${folder} on ${state.gitBranch}` : folder;
    pi.sendMessage(
      {
        customType: 'messenger_context',
        content: `You are agent "${state.agentName}" in ${locationPart}. Your current channel is ${displayChannelLabel(state.currentChannel)}. Named channel ${displayChannelLabel('memory')} exists for durable cross-session notes. Send direct messages with pi_messenger({ action: "send", to: "AgentName", message: "..." }). Post durable channel updates with pi_messenger({ action: "send", to: "${displayChannelLabel(state.currentChannel)}", message: "..." }) or named channels like ${displayChannelLabel('memory')}. Use pi_messenger({ action: "swarm" }) to inspect swarm tasks in the current channel, task.* to claim/complete work, join with { channel: "..." } to switch channels, and spawn.* to manage subagents.`,
        display: false,
      },
      { triggerTurn: false }
    );
  }

  // ===========================================================================
  // Tool Registration
  // ===========================================================================

  pi.registerTool({
    name: 'pi_messenger',
    label: 'Pi Messenger',
    description: `Multi-agent coordination and task orchestration.

Usage (swarm-first API):
  // Coordination
  pi_messenger({ action: "join" })
  pi_messenger({ action: "status" })
  pi_messenger({ action: "list" })
  pi_messenger({ action: "feed", limit: 20 })
  pi_messenger({ action: "send", to: "Agent", message: "hi" })
  pi_messenger({ action: "send", to: "#memory", message: "remember this" })
  pi_messenger({ action: "reserve", paths: ["src/"] })

  // Swarm board
  pi_messenger({ action: "swarm" })

  // Tasks (peer-created, peer-claimed)
  pi_messenger({ action: "task.create", title: "Investigate bug", content: "..." })
  pi_messenger({ action: "task.list" })
  pi_messenger({ action: "task.show", id: "task-1" })
  pi_messenger({ action: "task.claim", id: "task-1" })
  pi_messenger({ action: "task.progress", id: "task-1", message: "Checked auth middleware" })
  pi_messenger({ action: "task.done", id: "task-1", summary: "Implemented fix" })
  pi_messenger({ action: "task.archive_done" })
  // Dynamic subagents
  pi_messenger({ action: "spawn", role: "Researcher", message: "Analyze competitor X" })
  pi_messenger({ action: "spawn.list" })
  pi_messenger({ action: "spawn.stop", id: "<spawn-id>" })`,
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action to perform (e.g., 'join', 'swarm', 'task.create', 'spawn')",
        })
      ),

      // Core task fields
      id: Type.Optional(
        Type.String({ description: 'Task ID (task-N), or spawn ID for spawn.stop' })
      ),
      taskId: Type.Optional(
        Type.String({ description: 'Task ID alias for claim/unclaim/complete compatibility' })
      ),
      title: Type.Optional(
        Type.String({ description: 'Task title (task.create) or spawn role fallback' })
      ),
      content: Type.Optional(Type.String({ description: 'Task spec content or spawn context' })),
      dependsOn: Type.Optional(
        Type.Array(Type.String(), { description: 'Task dependencies for task.create' })
      ),
      summary: Type.Optional(Type.String({ description: 'Completion summary for task.done' })),
      evidence: Type.Optional(
        Type.Object(
          {
            commits: Type.Optional(Type.Array(Type.String())),
            tests: Type.Optional(Type.Array(Type.String())),
            prs: Type.Optional(Type.Array(Type.String())),
          },
          { description: 'Evidence for task.done' }
        )
      ),
      cascade: Type.Optional(
        Type.Boolean({ description: 'Cascade reset dependents (task.reset)' })
      ),

      // Spawn fields
      role: Type.Optional(Type.String({ description: 'Subagent role title for spawn' })),
      persona: Type.Optional(Type.String({ description: 'Optional subagent persona' })),
      prompt: Type.Optional(Type.String({ description: 'Alias objective text for spawn' })),

      // Coordination and utility
      limit: Type.Optional(Type.Number({ description: 'Feed line limit' })),
      paths: Type.Optional(Type.Array(Type.String(), { description: 'Paths for reserve/release' })),
      name: Type.Optional(Type.String({ description: 'Rename self or set spawned agent name' })),
      channel: Type.Optional(
        Type.String({
          description:
            "Optional channel name/id for join/feed/swarm/task actions, or to constrain a direct send to a specific joined channel. For channel posts, prefer to: '#channel'.",
        })
      ),
      create: Type.Optional(
        Type.Boolean({ description: 'Create the channel if it does not exist when joining.' })
      ),
      to: Type.Optional(
        Type.Any({
          description:
            "Required for send. Target agent name, array of agent names, or channel name starting with # (for example '#memory').",
        })
      ),
      message: Type.Optional(
        Type.String({ description: 'Message text for send, or spawn objective text.' })
      ),
      replyTo: Type.Optional(Type.String({ description: 'Message ID for replies' })),
      reason: Type.Optional(Type.String({ description: 'Reason for reserve or task.block' })),
      autoRegisterPath: Type.Optional(
        StringEnum(['add', 'remove', 'list'], { description: 'Manage auto-register paths' })
      ),

      // Legacy fields retained for backwards compatibility
      prd: Type.Optional(Type.String({ description: 'Legacy (unused in swarm mode)' })),
      target: Type.Optional(Type.String({ description: 'Legacy (unused in swarm mode)' })),
      type: Type.Optional(
        StringEnum(['plan', 'impl'], { description: 'Legacy (unused in swarm mode)' })
      ),
      autoWork: Type.Optional(Type.Boolean({ description: 'Legacy (unused in swarm mode)' })),
      autonomous: Type.Optional(Type.Boolean({ description: 'Legacy (unused in swarm mode)' })),
      concurrency: Type.Optional(Type.Number({ description: 'Legacy (unused in swarm mode)' })),
      count: Type.Optional(Type.Number({ description: 'Legacy (unused in swarm mode)' })),
      subtasks: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String(),
            content: Type.Optional(Type.String()),
          }),
          { description: 'Legacy (unused in swarm mode)' }
        )
      ),
      spec: Type.Optional(Type.String({ description: 'Legacy (unused in swarm mode)' })),
      notes: Type.Optional(Type.String({ description: 'Legacy completion notes' })),
    }),

    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const params = rawParams as MessengerActionParams;
      latestCtx = ctx;
      syncContextSession(ctx);

      const action = params.action;
      if (!action) {
        return handlers.executeStatus(state, dirs, ctx.cwd ?? process.cwd());
      }

      const result = await executeAction(
        action,
        params,
        state,
        dirs,
        ctx,
        deliverMessage,
        updateStatus,
        (type, data) => pi.appendEntry(type, data),
        {
          stuckThreshold: config.stuckThreshold,
          swarmEventsInFeed: config.swarmEventsInFeed,
          nameTheme,
          feedRetention: config.feedRetention,
        },
        signal
      );

      if (action === 'join' && state.registered && config.registrationContext) {
        sendRegistrationContext(ctx);
      }

      return result;
    },
  });

  // ===========================================================================
  // Commands
  // ===========================================================================

  pi.registerCommand('messenger', {
    description: "Open messenger overlay, or 'config' to manage settings",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      latestCtx = ctx;
      syncContextSession(ctx);

      // /messenger config - open config overlay
      if (args[0] === 'config') {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => {
            return new MessengerConfigOverlay(tui, theme, done);
          },
          { overlay: true }
        );
        return;
      }

      // /messenger - open chat overlay (auto-joins if not registered)
      if (!state.registered) {
        if (!store.register(state, dirs, ctx, nameTheme)) {
          ctx.ui.notify('Failed to join agent mesh', 'error');
          return;
        }
        store.startWatcher(state, dirs, deliverMessage);
        updateStatus(ctx);
      }

      if (overlayHandle && overlayHandle.isHidden()) {
        overlayHandle.setHidden(false);
        clearAllUnreadCounts();
        updateStatus(ctx);
        return;
      }

      const callbacks: OverlayCallbacks = {
        onBackground: (snapshotText) => {
          overlayHandle?.setHidden(true);
          pi.sendMessage(
            {
              customType: 'swarm_snapshot',
              content: snapshotText,
              display: true,
            },
            { triggerTurn: true }
          );
        },
        onSwitchChannel: (channelId) => {
          const switched = store.joinChannel(state, dirs, channelId);
          if (!switched.success) return false;
          store.stopWatcher(state);
          resetChannelScopedUiState();
          state.watcherRetries = 0;
          store.startWatcher(state, dirs, deliverMessage);
          updateStatus(ctx);
          return true;
        },
      };

      const snapshot = await ctx.ui.custom<string | undefined>(
        (tui, theme, _keybindings, done) => {
          overlayTui = tui;
          return new MessengerOverlay(tui, theme, state, dirs, done, callbacks);
        },
        {
          overlay: true,
          onHandle: (handle) => {
            overlayHandle = handle;
          },
        }
      );

      if (snapshot) {
        pi.sendMessage(
          {
            customType: 'swarm_snapshot',
            content: snapshot,
            display: true,
          },
          { triggerTurn: true }
        );
      }

      // Overlay closed
      clearAllUnreadCounts();
      overlayHandle = null;
      overlayTui = null;
      updateStatus(ctx);
    },
  });

  // ===========================================================================
  // Message Renderer
  // ===========================================================================

  pi.registerMessageRenderer<AgentMailMessage>('agent_message', (message, _options, theme) => {
    const details = message.details;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const safeFrom = stripAnsiCodes(details.from);
        const safeText = stripAnsiCodes(details.text);

        const header = theme.fg('accent', `From ${safeFrom}`);
        const time = theme.fg('dim', ` (${formatRelativeTime(details.timestamp)})`);

        const result: string[] = [];
        result.push(truncateToWidth(header + time, width));
        result.push('');

        for (const line of safeText.split('\n')) {
          result.push(truncateToWidth(line, width));
        }

        return result;
      },
      invalidate() {},
    };
  });

  // ===========================================================================
  // Activity Tracking
  // ===========================================================================
  // Activity Tracking
  // ===========================================================================

  const activityTracker = createActivityTracker({ state, dirs, config });

  pi.on('tool_call', async (event, ctx) => {
    await activityTracker.handleToolCall(event, ctx);
  });

  pi.on('tool_result', async (event, ctx) => {
    await activityTracker.handleToolResult(event, ctx);
  });

  // ===========================================================================
  // Event Handlers
  // ===========================================================================

  pi.on('session_start', async (_event, ctx) => {
    latestCtx = ctx;
    startStatusHeartbeat();
    state.isHuman = ctx.hasUI;
    try {
      fs.rmSync(join(homedir(), '.pi/agent/messenger/feed.jsonl'), { force: true });
    } catch {}

    syncContextSession(ctx);

    const shouldAutoRegister =
      config.autoRegister || matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);

    if (!shouldAutoRegister) {
      maybeAutoOpenSwarmOverlay(ctx);
      return;
    }

    const wasRegistered = state.registered;
    if (store.register(state, dirs, ctx, nameTheme)) {
      const cwd = ctx.cwd ?? process.cwd();
      store.startWatcher(state, dirs, deliverMessage);
      updateStatus(ctx);
      if (!wasRegistered) {
        pruneFeed(cwd, config.feedRetention, state.currentChannel);
        logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
      }

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }

    maybeAutoOpenSwarmOverlay(ctx);
  });

  function recoverWatcherIfNeeded(): void {
    if (state.registered && !state.watcher && !state.watcherRetryTimer) {
      state.watcherRetries = 0;
      store.startWatcher(state, dirs, deliverMessage);
    }
  }

  function maybeAutoOpenSwarmOverlay(_ctx: ExtensionContext): void {
    // Swarm mode intentionally disables planning/autonomous auto-overlay behavior.
  }

  pi.on('session_start', async (event, ctx) => {
    // Handle new, resume, and fork reasons (existing sessions), not startup/reload
    if (event.reason === 'startup' || event.reason === 'reload') return;
    latestCtx = ctx;
    syncContextSession(ctx);
    recoverWatcherIfNeeded();
    updateStatus(ctx);
    maybeAutoOpenSwarmOverlay(ctx);
  });
  pi.on('session_tree', async (_event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);
    maybeAutoOpenSwarmOverlay(ctx);
  });

  pi.on('turn_end', async (event, ctx) => {
    latestCtx = ctx;
    syncContextSession(ctx);
    store.processAllPendingMessages(state, dirs, deliverMessage);
    recoverWatcherIfNeeded();
    updateStatus(ctx);

    if (state.registered) {
      const msg = event.message as unknown as Record<string, unknown> | undefined;
      if (msg && msg.role === 'assistant' && msg.usage) {
        const usage = msg.usage as { totalTokens?: number; input?: number; output?: number };
        const total = usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
        if (total > 0) {
          state.session.tokens += total;
          activityTracker.scheduleRegistryFlush(ctx);
        }
      }
    }

    maybeAutoOpenSwarmOverlay(ctx);
  });

  // ===========================================================================
  // Agent End Lifecycle
  // ===========================================================================

  pi.on('agent_end', async (_event, ctx) => {
    latestCtx = ctx;
    updateStatus(ctx);
  });

  pi.on('session_shutdown', async () => {
    const cwd = process.cwd();
    stopAllSpawned(cwd);
    stopStatusHeartbeat();
    overlayOpening = false;
    overlayHandle = null;
    overlayTui = null;
    if (state.registered) {
      const channels =
        state.joinedChannels.length > 0 ? state.joinedChannels : [state.currentChannel];
      for (const channel of channels) {
        const claimedTasks = swarmStore
          .getTasks(cwd, channel)
          .filter((t) => t.status === 'in_progress' && t.claimed_by === state.agentName);
        for (const task of claimedTasks) {
          swarmStore.unclaimTask(cwd, task.id, state.agentName, channel);
          logFeedEvent(
            cwd,
            state.agentName,
            'task.reset',
            task.id,
            'agent left - task unclaimed',
            channel
          );
        }
      }
      const { listSpawned } = await import('./swarm/spawn.js');
      const spawnedAgents = listSpawned(cwd);
      const spawnedNames = new Set(spawnedAgents.map((s) => s.name));
      for (const channel of channels) {
        const spawnedClaimedTasks = swarmStore
          .getTasks(cwd, channel)
          .filter(
            (t) => t.status === 'in_progress' && t.claimed_by && spawnedNames.has(t.claimed_by)
          );
        for (const task of spawnedClaimedTasks) {
          swarmStore.unclaimTask(cwd, task.id, task.claimed_by!, channel);
          logFeedEvent(
            cwd,
            task.claimed_by!,
            'task.reset',
            task.id,
            'parent agent left - task unclaimed',
            channel
          );
        }
      }
      logFeedEvent(cwd, state.agentName, 'leave', undefined, undefined, state.currentChannel);
    }
    activityTracker.dispose();
    store.stopWatcher(state);
    store.unregister(state, dirs);
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on('tool_call', async (event, _ctx) => {
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
    lines.push(`Coordinate via pi_messenger({ action: "send", to: "${c.agent}", message: "..." })`);

    return { block: true, reason: lines.join('\n') };
  });
}
