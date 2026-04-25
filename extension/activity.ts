import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { Dirs, MessengerState } from '../lib.js';
import { generateAutoStatus } from '../lib.js';
import type { MessengerConfig } from '../config.js';
import * as store from '../store.js';
import { logFeedEvent } from '../feed/index.js';

interface ActivityTrackerOptions {
  state: MessengerState;
  dirs: Dirs;
  config: MessengerConfig;
}

export function createActivityTracker({ state, dirs, config }: ActivityTrackerOptions) {
  const EDIT_DEBOUNCE_MS = 5000;
  const REGISTRY_FLUSH_MS = 10000;
  const RECENT_WINDOW_MS = 60_000;
  const pendingEdits = new Map<string, ReturnType<typeof setTimeout>>();
  let recentCommit = false;
  let recentCommitTimer: ReturnType<typeof setTimeout> | null = null;
  let recentTestRuns = 0;
  let recentTestTimer: ReturnType<typeof setTimeout> | null = null;
  let recentEdits = 0;
  let recentEditTimer: ReturnType<typeof setTimeout> | null = null;

  function updateLastActivity(): void {
    state.activity.lastActivityAt = new Date().toISOString();
  }

  function incrementToolCount(): void {
    state.session.toolCalls++;
  }

  function setCurrentActivity(activity: string): void {
    state.activity.currentActivity = activity;
  }

  function clearCurrentActivity(): void {
    state.activity.currentActivity = undefined;
  }

  function setLastToolCall(toolCall: string): void {
    state.activity.lastToolCall = toolCall;
  }

  function addModifiedFile(filePath: string): void {
    const files = state.session.filesModified;
    const idx = files.indexOf(filePath);
    if (idx !== -1) files.splice(idx, 1);
    files.push(filePath);
    if (files.length > 20) files.shift();
  }

  function debouncedLogEdit(filePath: string): void {
    const existing = pendingEdits.get(filePath);
    if (existing) clearTimeout(existing);
    pendingEdits.set(
      filePath,
      setTimeout(() => {
        logFeedEvent(
          process.cwd(),
          state.agentName,
          'edit',
          filePath,
          undefined,
          state.currentChannel
        );
        pendingEdits.delete(filePath);
      }, EDIT_DEBOUNCE_MS)
    );
  }

  function scheduleRegistryFlush(ctx: ExtensionContext): void {
    if (state.registryFlushTimer) return;
    state.registryFlushTimer = setTimeout(() => {
      state.registryFlushTimer = null;
      store.flushActivityToRegistry(state, dirs, ctx);
    }, REGISTRY_FLUSH_MS);
  }

  function isGitCommit(command: string): boolean {
    return /\bgit\s+commit\b/.test(command);
  }

  function isTestRun(command: string): boolean {
    return /\b(npm\s+test|npx\s+(jest|vitest|mocha)|pytest|go\s+test|cargo\s+test|bun\s+test)\b/.test(
      command
    );
  }

  function extractCommitMessage(command: string): string {
    const match = command.match(/-m\s+["']([^"']+)["']/);
    return match ? match[1] : '';
  }

  function updateAutoStatus(): void {
    if (!state.registered || !config.autoStatus || state.customStatus) return;

    const autoMsg = generateAutoStatus({
      currentActivity: state.activity.currentActivity,
      recentCommit,
      recentTestRuns,
      recentEdits,
      sessionStartedAt: state.sessionStartedAt,
    });

    state.statusMessage = autoMsg;
  }

  function trackRecentCommit(): void {
    recentCommit = true;
    if (recentCommitTimer) clearTimeout(recentCommitTimer);
    recentCommitTimer = setTimeout(() => {
      recentCommit = false;
    }, RECENT_WINDOW_MS);
  }

  function trackRecentTest(): void {
    recentTestRuns++;
    if (recentTestTimer) clearTimeout(recentTestTimer);
    recentTestTimer = setTimeout(() => {
      recentTestRuns = 0;
    }, RECENT_WINDOW_MS);
  }

  function trackRecentEdit(): void {
    recentEdits++;
    if (recentEditTimer) clearTimeout(recentEditTimer);
    recentEditTimer = setTimeout(() => {
      recentEdits = 0;
    }, RECENT_WINDOW_MS);
  }

  function shortenPath(filePath: string): string {
    const parts = filePath.split('/');
    return parts.length > 2 ? parts.slice(-2).join('/') : filePath;
  }

  async function handleToolCall(
    event: { toolName: string; input: unknown },
    ctx: ExtensionContext
  ): Promise<void> {
    if (!state.registered) return;

    updateLastActivity();
    incrementToolCount();
    scheduleRegistryFlush(ctx);

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === 'write' || toolName === 'edit') {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`editing ${shortenPath(path)}`);
        debouncedLogEdit(path);
        trackRecentEdit();
      }
    } else if (toolName === 'read') {
      const path = input.path as string;
      if (path) {
        setCurrentActivity(`reading ${shortenPath(path)}`);
      }
    } else if (toolName === 'bash') {
      const command = input.command as string;
      if (command) {
        if (isGitCommit(command)) {
          setCurrentActivity('committing');
        } else if (isTestRun(command)) {
          setCurrentActivity('running tests');
        }
      }
    }

    updateAutoStatus();
  }

  async function handleToolResult(
    event: { toolName: string; input: unknown; isError?: boolean },
    ctx: ExtensionContext
  ): Promise<void> {
    if (!state.registered) return;

    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === 'write' || toolName === 'edit') {
      const path = input.path as string;
      if (path) {
        setLastToolCall(`${toolName}: ${shortenPath(path)}`);
        addModifiedFile(path);
      }
    }

    if (toolName === 'bash') {
      const command = input.command as string;
      if (command) {
        const cwd = ctx.cwd ?? process.cwd();
        if (isGitCommit(command)) {
          const msg = extractCommitMessage(command);
          logFeedEvent(cwd, state.agentName, 'commit', undefined, msg, state.currentChannel);
          setLastToolCall(`commit: ${msg}`);
          trackRecentCommit();
        }
        if (isTestRun(command)) {
          const passed = !event.isError;
          logFeedEvent(
            cwd,
            state.agentName,
            'test',
            undefined,
            passed ? 'passed' : 'failed',
            state.currentChannel
          );
          setLastToolCall(`test: ${passed ? 'passed' : 'failed'}`);
          trackRecentTest();
        }
      }
    }

    clearCurrentActivity();
    updateAutoStatus();
    scheduleRegistryFlush(ctx);
  }

  function dispose(): void {
    if (state.registryFlushTimer) {
      clearTimeout(state.registryFlushTimer);
      state.registryFlushTimer = null;
    }
    for (const timer of pendingEdits.values()) {
      clearTimeout(timer);
    }
    pendingEdits.clear();
    if (recentCommitTimer) {
      clearTimeout(recentCommitTimer);
      recentCommitTimer = null;
    }
    if (recentTestTimer) {
      clearTimeout(recentTestTimer);
      recentTestTimer = null;
    }
    if (recentEditTimer) {
      clearTimeout(recentEditTimer);
      recentEditTimer = null;
    }
  }

  return {
    handleToolCall,
    handleToolResult,
    scheduleRegistryFlush,
    dispose,
  };
}
