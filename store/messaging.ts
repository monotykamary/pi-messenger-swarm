import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AgentMailMessage, Dirs, MessengerState } from '../lib.js';
import { MAX_WATCHER_RETRIES } from '../lib.js';
import { normalizeChannelId } from '../channel.js';
import { ensureDirSync, getMyInbox, getMyInboxRoot } from './shared.js';

let isProcessingMessages = false;
let pendingProcessArgs: {
  state: MessengerState;
  dirs: Dirs;
  deliverFn: (msg: AgentMailMessage) => void;
} | null = null;

export { getMyInbox, getMyInboxRoot };

export function processAllPendingMessages(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;

  if (isProcessingMessages) {
    pendingProcessArgs = { state, dirs, deliverFn };
    return;
  }

  isProcessingMessages = true;

  try {
    const inbox = getMyInbox(state, dirs, state.currentChannel);
    if (!fs.existsSync(inbox)) return;

    let files: string[];
    try {
      files = fs
        .readdirSync(inbox)
        .filter((f) => f.endsWith('.json'))
        .sort();
    } catch {
      return;
    }

    for (const file of files) {
      const msgPath = join(inbox, file);
      try {
        const content = fs.readFileSync(msgPath, 'utf-8');
        const msg = JSON.parse(content) as AgentMailMessage;
        msg.channel = msg.channel ? normalizeChannelId(msg.channel) : state.currentChannel;
        deliverFn(msg);
        fs.unlinkSync(msgPath);
      } catch {
        try {
          fs.unlinkSync(msgPath);
        } catch {
          // Already gone or can't delete
        }
      }
    }
  } finally {
    isProcessingMessages = false;

    if (pendingProcessArgs) {
      const args = pendingProcessArgs;
      pendingProcessArgs = null;
      processAllPendingMessages(args.state, args.dirs, args.deliverFn);
    }
  }
}

export function sendMessageToAgent(
  state: MessengerState,
  dirs: Dirs,
  to: string,
  text: string,
  replyTo?: string,
  channelId?: string
): AgentMailMessage {
  const resolvedChannel = normalizeChannelId(channelId ?? state.currentChannel);
  const targetInbox = join(dirs.inbox, to, resolvedChannel);
  ensureDirSync(targetInbox);

  const msg: AgentMailMessage = {
    id: randomUUID(),
    from: state.agentName,
    to,
    text,
    timestamp: new Date().toISOString(),
    replyTo: replyTo ?? null,
    channel: resolvedChannel,
  };

  const random = Math.random().toString(36).substring(2, 8);
  const msgFile = join(targetInbox, `${Date.now()}-${random}.json`);
  fs.writeFileSync(msgFile, JSON.stringify(msg, null, 2));

  return msg;
}

const WATCHER_DEBOUNCE_MS = 50;

export function startWatcher(
  state: MessengerState,
  dirs: Dirs,
  deliverFn: (msg: AgentMailMessage) => void
): void {
  if (!state.registered) return;
  if (state.watcher) return;
  if (state.watcherRetries >= MAX_WATCHER_RETRIES) return;

  const inbox = getMyInbox(state, dirs, state.currentChannel);
  ensureDirSync(inbox);

  processAllPendingMessages(state, dirs, deliverFn);

  function scheduleRetry(): void {
    state.watcherRetries++;
    if (state.watcherRetries < MAX_WATCHER_RETRIES) {
      const delay = Math.min(1000 * Math.pow(2, state.watcherRetries - 1), 30000);
      state.watcherRetryTimer = setTimeout(() => {
        state.watcherRetryTimer = null;
        startWatcher(state, dirs, deliverFn);
      }, delay);
    }
  }

  try {
    state.watcher = fs.watch(inbox, () => {
      if (state.watcherDebounceTimer) {
        clearTimeout(state.watcherDebounceTimer);
      }
      state.watcherDebounceTimer = setTimeout(() => {
        state.watcherDebounceTimer = null;
        processAllPendingMessages(state, dirs, deliverFn);
      }, WATCHER_DEBOUNCE_MS);
    });
  } catch {
    scheduleRetry();
    return;
  }

  state.watcher.on('error', () => {
    stopWatcher(state);
    scheduleRetry();
  });

  state.watcherRetries = 0;
}

export function stopWatcher(state: MessengerState): void {
  if (state.watcherDebounceTimer) {
    clearTimeout(state.watcherDebounceTimer);
    state.watcherDebounceTimer = null;
  }
  if (state.watcherRetryTimer) {
    clearTimeout(state.watcherRetryTimer);
    state.watcherRetryTimer = null;
  }
  if (state.watcher) {
    state.watcher.close();
    state.watcher = null;
  }
}
