import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import type { AgentMailMessage, Dirs, MessengerState } from '../lib.js';
import { extractFolder, MAX_CHAT_HISTORY } from '../lib.js';
import type { MessengerConfig } from '../config.js';
import * as store from '../store.js';

interface DeliverMessageOptions {
  pi: ExtensionAPI;
  state: MessengerState;
  dirs: Dirs;
  config: MessengerConfig;
  requestRender?: () => void;
}

export function createDeliverMessage({
  pi,
  state,
  dirs,
  config,
  requestRender,
}: DeliverMessageOptions) {
  return function deliverMessage(msg: AgentMailMessage): void {
    let history = state.chatHistory.get(msg.from);
    if (!history) {
      history = [];
      state.chatHistory.set(msg.from, history);
    }
    history.push(msg);
    if (history.length > MAX_CHAT_HISTORY) history.shift();

    const current = state.unreadCounts.get(msg.from) ?? 0;
    state.unreadCounts.set(msg.from, current + 1);

    requestRender?.();

    const sender = store.getActiveAgents(state, dirs).find((a) => a.name === msg.from);
    const senderSessionId = sender?.sessionId;
    const prevSessionId = state.seenSenders.get(msg.from);
    const isNewIdentity = !prevSessionId || (senderSessionId && prevSessionId !== senderSessionId);

    if (senderSessionId) {
      state.seenSenders.set(msg.from, senderSessionId);
    }

    let content = '';

    if (isNewIdentity && config.senderDetailsOnFirstContact && sender) {
      const folder = extractFolder(sender.cwd);
      const locationPart = sender.gitBranch ? `${folder} on ${sender.gitBranch}` : folder;
      content += `*${msg.from} is in ${locationPart} (${sender.model})*\n\n`;
    }

    const replyHint = config.replyHint ? ` — reply: pi-messenger-swarm send ${msg.from} "..."` : '';

    content += `**Message from ${msg.from}**${replyHint}\n\n${msg.text}`;

    if (msg.replyTo) {
      content = `*(reply to ${msg.replyTo.substring(0, 8)})*\n\n${content}`;
    }

    pi.sendMessage(
      { customType: 'agent_message', content, display: true, details: msg },
      { triggerTurn: true, deliverAs: 'steer' }
    );
  };
}
