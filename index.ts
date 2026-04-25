/**
 * Pi Messenger Extension
 *
 * Enables pi agents to discover and communicate with each other across terminal sessions.
 * Uses file-based coordination with a harness server for action dispatch.
 *
 * Architecture:
 * - This extension manages lifecycle hooks (registration, status, overlay, reservations)
 * - A long-lived harness server (pi-messenger-swarm) handles all action dispatch
 * - Models interact via the CLI, not a tool call — no eager invocation risk
 * - The SKILL.md teaches models how to use the CLI
 */

import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { OverlayHandle, TUI } from '@mariozechner/pi-tui';
import { truncateToWidth } from '@mariozechner/pi-tui';
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
import { getContextSessionId, getEffectiveSessionId } from './store/shared.js';
import { MessengerOverlay, type OverlayCallbacks } from './overlay/component.js';
import { MessengerConfigOverlay } from './overlay/config-overlay.js';
import { loadConfig, matchesAutoRegisterPath, type MessengerConfig } from './config.js';
import { logFeedEvent, pruneFeed } from './feed/index.js';
import { onLiveWorkersChanged } from './swarm/live-progress.js';
import { stopAllSpawned } from './swarm/spawn.js';
import { createDeliverMessage } from './extension/deliver-message.js';
import { createStatusController } from './extension/status.js';
import { createActivityTracker } from './extension/activity.js';
import { installShellAlias, createHarnessServer } from './extension/harness.js';
import { handleReservationEnforcement } from './extension/reservation.js';
import { handleSessionShutdown } from './extension/shutdown.js';

let overlayTui: TUI | null = null;
let overlayHandle: OverlayHandle | null = null;
let overlayOpening = false;

export default function piMessengerExtension(pi: ExtensionAPI) {
  // ===========================================================================
  // State & Configuration
  // ===========================================================================

  const config: MessengerConfig = loadConfig(process.cwd());

  const state: MessengerState = {
    agentName: '',
    registered: false,
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

    resetChannelScopedUiState();
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
    overlayTui?.requestRender();
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
        content: `You are agent "${state.agentName}" in ${locationPart}. Your current channel is ${displayChannelLabel(state.currentChannel)}. Named channel ${displayChannelLabel('memory')} exists for durable cross-session notes. Use pi-messenger-swarm for all coordination. Examples: pi-messenger-swarm join | pi-messenger-swarm swarm | pi-messenger-swarm task create --title "..." | pi-messenger-swarm task claim task-1 | pi-messenger-swarm spawn --role Researcher "Analyze X" | pi-messenger-swarm send AgentName "hello" | pi-messenger-swarm feed --limit 20. See SKILL for full reference.`,
        display: false,
      },
      { triggerTurn: false }
    );
  }

  // ===========================================================================
  // Harness Server
  // ===========================================================================

  const harnessServer = createHarnessServer();

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
        updateStatus(ctx);
        if (config.registrationContext) {
          sendRegistrationContext(ctx);
        }
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
          resetChannelScopedUiState();
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

    // Write the session ID to disk so the harness server (and CLI)
    // can discover it. The harness runs as a separate process and
    // has no access to pi's SessionManager — this file bridges that gap.
    const sessionId = getContextSessionId(ctx);
    if (sessionId) {
      try {
        const sessionFilePath = join(dirs.base, 'session-id');
        fs.writeFileSync(sessionFilePath, sessionId, 'utf-8');
      } catch {
        // Best effort
      }
    }

    // Install the CLI wrapper so all child bash processes
    // can find and use pi-messenger-swarm.
    installShellAlias();

    const shouldAutoRegister =
      config.autoRegister || matchesAutoRegisterPath(process.cwd(), config.autoRegisterPaths);

    // Start the harness server even without auto-register —
    // the model needs it for CLI actions regardless.
    if (!process.env.PI_SWARM_SPAWNED) {
      harnessServer.start();
    }

    if (!shouldAutoRegister) {
      maybeAutoOpenSwarmOverlay(ctx);
      return;
    }

    const wasRegistered = state.registered;
    if (store.register(state, dirs, ctx, nameTheme)) {
      updateStatus(ctx);
      if (!wasRegistered) {
        const cwd = ctx.cwd ?? process.cwd();
        pruneFeed(cwd, config.feedRetention, state.currentChannel);
        logFeedEvent(cwd, state.agentName, 'join', undefined, undefined, state.currentChannel);
      }

      if (config.registrationContext) {
        sendRegistrationContext(ctx);
      }
    }

    maybeAutoOpenSwarmOverlay(ctx);
  });

  function maybeAutoOpenSwarmOverlay(_ctx: ExtensionContext): void {
    // Swarm mode intentionally disables planning/autonomous auto-overlay behavior.
  }

  pi.on('session_start', async (event, ctx) => {
    // Handle new, resume, and fork reasons (existing sessions), not startup/reload
    if (event.reason === 'startup' || event.reason === 'reload') return;
    latestCtx = ctx;
    syncContextSession(ctx);
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
    harnessServer.stop();
    overlayOpening = false;
    overlayHandle = null;
    overlayTui = null;
    await handleSessionShutdown(state, dirs);
    activityTracker.dispose();
  });

  // ===========================================================================
  // Reservation Enforcement
  // ===========================================================================

  pi.on('tool_call', async (event, ctx) => {
    return handleReservationEnforcement(event, ctx, state, dirs);
  });
}
