/**
 * Pi Messenger - Chat Overlay Component
 */

import { randomUUID } from "node:crypto";
import type { Component, Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  MAX_CHAT_HISTORY,
  formatRelativeTime,
  coloredAgentName,
  stripAnsiCodes,
  extractFolder,
  truncatePathLeft,
  getDisplayMode,
  displaySpecPath,
  computeStatus,
  STATUS_INDICATORS,
  buildSelfRegistration,
  agentHasTask,
  type MessengerState,
  type Dirs,
  type AgentMailMessage,
  type AgentRegistration,
} from "./lib.js";
import * as store from "./store.js";
import * as crewStore from "./crew/store.js";
import { readFeedEvents, formatFeedLine as sharedFormatFeedLine, logFeedEvent, type FeedEvent } from "./feed.js";
import {
  renderCrewContent,
  renderCrewStatusBar,
  createCrewViewState,
  navigateTask,
  type CrewViewState,
} from "./crew-overlay.js";
import { hasLiveWorkers, onLiveWorkersChanged } from "./crew/live-progress.js";
import { loadConfig } from "./config.js";

const AGENTS_TAB = "[agents]";
const CREW_TAB = "[crew]";

export class MessengerOverlay implements Component, Focusable {
  readonly width = 80;
  focused = false;

  private selectedAgent: string | null = null;
  private inputText = "";
  private scrollPosition = 0;
  private cachedAgents: AgentRegistration[] | null = null;
  private crewViewState: CrewViewState = createCrewViewState();
  private cwd: string;
  private stuckThresholdMs: number;
  private progressTimer: ReturnType<typeof setInterval> | null = null;
  private progressUnsubscribe: (() => void) | null = null;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private state: MessengerState,
    private dirs: Dirs,
    private done: () => void
  ) {
    this.cwd = process.cwd();
    const cfg = loadConfig(this.cwd);
    this.stuckThresholdMs = cfg.stuckThreshold * 1000;
    const agents = this.getAgentsSorted();
    const withUnread = agents.find(a => (state.unreadCounts.get(a.name) ?? 0) > 0);
    this.selectedAgent = withUnread?.name ?? AGENTS_TAB;

    if (this.selectedAgent && this.selectedAgent !== AGENTS_TAB && this.selectedAgent !== CREW_TAB) {
      state.unreadCounts.set(this.selectedAgent, 0);
    }

    this.progressUnsubscribe = onLiveWorkersChanged(() => {
      if (this.selectedAgent === CREW_TAB) {
        if (hasLiveWorkers(this.cwd)) this.startProgressRefresh();
        else this.stopProgressRefresh();
      }
      this.tui.requestRender();
    });

    if (this.selectedAgent === CREW_TAB && hasLiveWorkers(this.cwd)) {
      this.startProgressRefresh();
    }
  }

  private getAgentsSorted(): AgentRegistration[] {
    if (this.cachedAgents) return this.cachedAgents;
    this.cachedAgents = store.getActiveAgents(this.state, this.dirs).sort((a, b) => a.name.localeCompare(b.name));
    return this.cachedAgents;
  }

  private hasAnySpec(agents: AgentRegistration[]): boolean {
    if (this.state.spec) return true;
    return agents.some(agent => agent.spec);
  }

  private hasPlan(): boolean {
    return crewStore.hasPlan(this.cwd);
  }

  private getMessages(): AgentMailMessage[] {
    if (this.selectedAgent === null) {
      return this.state.broadcastHistory;
    }
    if (this.selectedAgent === AGENTS_TAB || this.selectedAgent === CREW_TAB) {
      return [];
    }
    return this.state.chatHistory.get(this.selectedAgent) ?? [];
  }

  private selectTab(agentName: string | null): void {
    this.selectedAgent = agentName;
    if (agentName && agentName !== AGENTS_TAB && agentName !== CREW_TAB) {
      this.state.unreadCounts.set(agentName, 0);
    }
    this.scrollPosition = 0;

    if (agentName === CREW_TAB && hasLiveWorkers(this.cwd)) {
      this.startProgressRefresh();
    } else {
      this.stopProgressRefresh();
    }
  }

  private startProgressRefresh(): void {
    if (this.progressTimer) return;
    this.progressTimer = setInterval(() => {
      if (hasLiveWorkers(this.cwd)) {
        this.tui.requestRender();
      } else {
        this.stopProgressRefresh();
      }
    }, 1000);
  }

  private stopProgressRefresh(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private scroll(delta: number): void {
    const messages = this.getMessages();
    const maxScroll = Math.max(0, messages.length - 1);
    this.scrollPosition = Math.max(0, Math.min(maxScroll, this.scrollPosition + delta));
  }

  handleInput(data: string): void {
    const agents = this.getAgentsSorted();

    // Allow escape always
    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }

    // If no agents AND no plan, only allow escape
    if (agents.length === 0 && !this.hasPlan()) {
      return;
    }

    if (matchesKey(data, "tab") || matchesKey(data, "right")) {
      this.cycleTab(1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
      this.cycleTab(-1, agents);
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "up")) {
      if (this.selectedAgent === CREW_TAB) {
        // Navigate tasks in crew view
        const tasks = crewStore.getTasks(this.cwd);
        navigateTask(this.crewViewState, -1, tasks.length);
      } else {
        this.scroll(1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "down")) {
      if (this.selectedAgent === CREW_TAB) {
        // Navigate tasks in crew view
        const tasks = crewStore.getTasks(this.cwd);
        navigateTask(this.crewViewState, 1, tasks.length);
      } else {
        this.scroll(-1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "home")) {
      if (this.selectedAgent === CREW_TAB) {
        this.crewViewState.selectedTaskIndex = 0;
        this.crewViewState.scrollOffset = 0;
      } else {
        const messages = this.getMessages();
        this.scrollPosition = Math.max(0, messages.length - 1);
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "end")) {
      if (this.selectedAgent === CREW_TAB) {
        const tasks = crewStore.getTasks(this.cwd);
        this.crewViewState.selectedTaskIndex = Math.max(0, tasks.length - 1);
      } else {
        this.scrollPosition = 0;
      }
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "enter")) {
      if (this.selectedAgent === CREW_TAB) {
        return;
      }
      if (this.inputText.trim()) {
        this.sendMessage(agents);
      }
      return;
    }

    if (matchesKey(data, "backspace")) {
      if (this.inputText.length > 0) {
        this.inputText = this.inputText.slice(0, -1);
        this.tui.requestRender();
      }
      return;
    }

    if (data.length > 0 && data.charCodeAt(0) >= 32) {
      this.inputText += data;
      this.tui.requestRender();
    }
  }

  private cycleTab(direction: number, agents: AgentRegistration[]): void {
    // Build tab list: Agents, Crew (if plan exists), individual agents, All
    const tabNames: (string | null)[] = [AGENTS_TAB];
    if (this.hasPlan()) {
      tabNames.push(CREW_TAB);
    }
    tabNames.push(...agents.map(a => a.name));
    tabNames.push(null); // "All" broadcast tab

    const currentIdx = this.selectedAgent === null
      ? tabNames.length - 1
      : tabNames.indexOf(this.selectedAgent);

    const newIdx = (currentIdx + direction + tabNames.length) % tabNames.length;
    this.selectTab(tabNames[newIdx]);
  }

  private sendMessage(agents: AgentRegistration[]): void {
    let text = this.inputText.trim();
    if (!text) return;

    let targetAgent: string | null = null;
    let isBroadcast = false;

    if (text.startsWith("@all ")) {
      text = text.slice(5).trim();
      isBroadcast = true;
    } else if (text.startsWith("@")) {
      const spaceIdx = text.indexOf(" ");
      if (spaceIdx > 1) {
        const name = text.slice(1, spaceIdx);
        const agent = agents.find(a => a.name === name);
        if (agent) {
          targetAgent = name;
          text = text.slice(spaceIdx + 1).trim();
        }
      }
    }

    if (!text) return;

    if (isBroadcast || (this.selectedAgent === null && !targetAgent) || this.selectedAgent === AGENTS_TAB) {
      for (const agent of agents) {
        try {
          store.sendMessageToAgent(this.state, this.dirs, agent.name, text);
        } catch {
          // Ignore
        }
      }
      const broadcastMsg: AgentMailMessage = {
        id: randomUUID(),
        from: this.state.agentName,
        to: "broadcast",
        text,
        timestamp: new Date().toISOString(),
        replyTo: null
      };
      this.state.broadcastHistory.push(broadcastMsg);
      if (this.state.broadcastHistory.length > MAX_CHAT_HISTORY) {
        this.state.broadcastHistory.shift();
      }
      const preview = text.length > 60 ? text.slice(0, 57) + "..." : text;
      logFeedEvent(this.dirs, this.state.agentName, "message", undefined, `broadcast: "${preview}"`);
      this.inputText = "";
      this.scrollPosition = 0;
      this.tui.requestRender();
    } else {
      const recipient = targetAgent ?? this.selectedAgent;
      if (!recipient || recipient === AGENTS_TAB || recipient === CREW_TAB) return;

      try {
        const msg = store.sendMessageToAgent(this.state, this.dirs, recipient, text);
        let history = this.state.chatHistory.get(recipient);
        if (!history) {
          history = [];
          this.state.chatHistory.set(recipient, history);
        }
        history.push(msg);
        if (history.length > MAX_CHAT_HISTORY) history.shift();
        const preview = text.length > 60 ? text.slice(0, 57) + "..." : text;
        logFeedEvent(this.dirs, this.state.agentName, "message", recipient, `\u2192 ${recipient}: "${preview}"`);
        this.inputText = "";
        this.scrollPosition = 0;
        this.tui.requestRender();
      } catch {
        // Keep input on failure
      }
    }
  }

  render(_width: number): string[] {
    this.cachedAgents = null;  // Clear cache at start of render cycle
    const w = this.width;
    const innerW = w - 2;
    const agents = this.getAgentsSorted();

    // Handle agent death - don't reset if we're on a meta tab (AGENTS_TAB, CREW_TAB)
    if (this.selectedAgent && 
        this.selectedAgent !== AGENTS_TAB && 
        this.selectedAgent !== CREW_TAB && 
        !agents.find(a => a.name === this.selectedAgent)) {
      this.selectedAgent = agents[0]?.name ?? (this.hasPlan() ? CREW_TAB : AGENTS_TAB);
      this.scrollPosition = 0;
    }

    const border = (s: string) => this.theme.fg("dim", s);
    const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) => border("│") + pad(" " + content, innerW) + border("│");
    const emptyRow = () => border("│") + " ".repeat(innerW) + border("│");

    const lines: string[] = [];

    // Top border with title
    const titleContent = this.renderTitleContent(agents.length);
    const titleText = ` ${titleContent} `;
    const titleLen = visibleWidth(titleContent) + 2;
    const borderLen = Math.max(0, innerW - titleLen);
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;
    lines.push(border("╭" + "─".repeat(leftBorder)) + titleText + border("─".repeat(rightBorder) + "╮"));

    if (agents.length === 0 && !this.hasPlan()) {
      // Simple empty state - no height filling
      lines.push(emptyRow());
      lines.push(emptyRow());
      lines.push(row(this.centerText("No other agents active", innerW - 2)));
      lines.push(emptyRow());
      lines.push(row(this.theme.fg("dim", this.centerText("Start another pi instance to chat", innerW - 2))));
      lines.push(emptyRow());
      lines.push(emptyRow());
    } else {
      lines.push(emptyRow());
      lines.push(row(this.renderTabBar(innerW - 2, agents)));
      lines.push(border("├" + "─".repeat(innerW) + "┤"));

      const chromeLines = 7; // top border, empty row, tab bar, separator, separator, input bar, bottom border
      const termRows = process.stdout.rows ?? 24;
      const messageAreaHeight = Math.min(25, Math.max(8, termRows - chromeLines - 2));
      const messageLines = this.renderMessages(innerW - 2, messageAreaHeight, agents);
      for (const line of messageLines) {
        lines.push(row(line));
      }

      lines.push(border("├" + "─".repeat(innerW) + "┤"));
      lines.push(row(this.renderInputBar(innerW - 2)));
    }

    // Bottom border
    lines.push(border("╰" + "─".repeat(innerW) + "╯"));

    return lines;
  }

  private centerText(text: string, width: number): string {
    const padding = Math.max(0, width - visibleWidth(text));
    const left = Math.floor(padding / 2);
    return " ".repeat(left) + text;
  }

  private renderTitleContent(peerCount: number): string {
    const label = this.theme.fg("accent", "Messenger");
    const totalCount = peerCount + 1;
    const count = this.theme.fg("dim", `${totalCount} agent${totalCount === 1 ? "" : "s"}`);
    const folder = this.theme.fg("dim", extractFolder(process.cwd()));

    return `${label} ─ ${count} ─ ${folder}`;
  }

  private renderTabBar(width: number, agents: AgentRegistration[]): string {
    const parts: string[] = [];
    const hasAnySpec = this.hasAnySpec(agents);
    const mode = getDisplayMode(agents);

    // Agents tab
    const isAgentsSelected = this.selectedAgent === AGENTS_TAB;
    let agentsTab = isAgentsSelected ? "▸ " : "";
    agentsTab += this.theme.fg("accent", "Agents");
    parts.push(agentsTab);

    // Crew tab (only if plan exists)
    if (this.hasPlan()) {
      const isCrewSelected = this.selectedAgent === CREW_TAB;
      let crewTab = isCrewSelected ? "▸ " : "";
      crewTab += this.theme.fg("accent", "Crew");
      
      // Show task progress
      const plan = crewStore.getPlan(this.cwd);
      if (plan && plan.task_count > 0) {
        crewTab += ` (${plan.completed_count}/${plan.task_count})`;
      }
      parts.push(crewTab);
    }

    for (const agent of agents) {
      const isSelected = this.selectedAgent === agent.name;
      const unread = this.state.unreadCounts.get(agent.name) ?? 0;

      let tab = isSelected ? "▸ " : "";
      tab += "● ";
      tab += coloredAgentName(agent.name);

      if (hasAnySpec) {
        if (agent.spec) {
          const specLabel = truncatePathLeft(displaySpecPath(agent.spec, process.cwd()), 14);
          tab += `:${specLabel}`;
        }
      } else if (mode === "same-folder") {
        if (agent.gitBranch) {
          tab += `:${agent.gitBranch}`;
        }
      } else if (mode === "different") {
        tab += `/${extractFolder(agent.cwd)}`;
      }

      if (unread > 0 && !isSelected) {
        tab += ` (${unread})`;
      }

      parts.push(tab);
    }

    const isAllSelected = this.selectedAgent === null;
    let allTab = isAllSelected ? "▸ " : "";
    allTab += this.theme.fg("accent", "+ All");
    parts.push(allTab);

    const content = parts.join(" │ ");
    return truncateToWidth(content, width);
  }

  private renderMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    if (this.selectedAgent === AGENTS_TAB) {
      return this.renderAgentsOverview(width, height, agents);
    }

    if (this.selectedAgent === CREW_TAB) {
      return renderCrewContent(this.theme, this.cwd, width, height, this.crewViewState);
    }

    const messages = this.getMessages();

    if (messages.length === 0) {
      return this.renderNoMessages(width, height, agents);
    }

    const maxVisibleMessages = Math.max(1, Math.floor(height / 3));
    const endIdx = messages.length - this.scrollPosition;
    const startIdx = Math.max(0, endIdx - maxVisibleMessages);
    const visibleMessages = messages.slice(startIdx, endIdx);

    const allRenderedLines: string[] = [];
    for (const msg of visibleMessages) {
      const msgLines = this.renderMessageBox(msg, width - 2);
      allRenderedLines.push(...msgLines);
    }

    if (allRenderedLines.length > height) {
      return allRenderedLines.slice(allRenderedLines.length - height);
    }

    while (allRenderedLines.length < height) {
      allRenderedLines.unshift("");
    }
    return allRenderedLines;
  }

  private renderAgentsOverview(width: number, height: number, agents: AgentRegistration[]): string[] {
    const lines: string[] = [];
    const allClaims = store.getClaims(this.dirs);

    const renderCard = (a: AgentRegistration, isSelf: boolean): void => {
      const computed = computeStatus(
        a.activity?.lastActivityAt ?? a.startedAt,
        agentHasTask(a.name, allClaims, crewStore.getTasks(a.cwd)),
        (a.reservations?.length ?? 0) > 0,
        this.stuckThresholdMs
      );
      const indicator = STATUS_INDICATORS[computed.status];
      const nameLabel = isSelf ? `${a.name} (you)` : a.name;
      const nameColored = isSelf
        ? this.theme.fg("accent", nameLabel)
        : coloredAgentName(a.name);

      let rightSide = "";
      let rightPlainText = "";
      if (computed.status === "idle" && computed.idleFor) {
        rightPlainText = `idle ${computed.idleFor}`;
        rightSide = this.theme.fg("dim", rightPlainText);
      } else if (computed.status === "away" && computed.idleFor) {
        rightPlainText = `away ${computed.idleFor}`;
        rightSide = this.theme.fg("dim", rightPlainText);
      } else if (computed.status === "stuck") {
        rightPlainText = "stuck";
        rightSide = this.theme.fg("error", rightPlainText);
      }

      const headerLeft = `${indicator} ${nameColored}`;
      if (rightSide) {
        const headerLeftLen = visibleWidth(`${indicator} ${nameLabel}`);
        const rightLen = visibleWidth(rightPlainText);
        const gap = Math.max(1, width - headerLeftLen - rightLen);
        lines.push(truncateToWidth(headerLeft + " ".repeat(gap) + rightSide, width));
      } else {
        lines.push(truncateToWidth(headerLeft, width));
      }

      const detailParts: string[] = [];
      if (a.activity?.currentActivity) {
        detailParts.push(a.activity.currentActivity);
      }
      const tools = a.session?.toolCalls ?? 0;
      detailParts.push(`${tools} tools`);
      const tokens = a.session?.tokens ?? 0;
      detailParts.push(tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`);
      if (a.reservations && a.reservations.length > 0) {
        detailParts.push(`\u{1F4C1} ${a.reservations.map(r => r.pattern).join(", ")}`);
      }
      if (a.statusMessage) {
        detailParts.push(a.statusMessage);
      }
      lines.push(truncateToWidth(`   ${detailParts.join(" - ")}`, width));
      lines.push("");
    };

    renderCard(buildSelfRegistration(this.state), true);
    for (const agent of agents) {
      renderCard(agent, false);
    }

    const feedHeight = Math.max(0, height - lines.length - 1);
    if (feedHeight > 1) {
      const events = readFeedEvents(this.dirs, feedHeight);
      if (events.length > 0) {
        lines.push(this.theme.fg("dim", "Activity"));
        for (const event of events.slice(-(feedHeight - 1))) {
          lines.push(truncateToWidth(this.formatFeedLine(event), width));
        }
      }
    }

    if (lines.length > height) {
      return lines.slice(0, height);
    }
    while (lines.length < height) lines.push("");
    return lines;
  }

  private formatFeedLine(event: FeedEvent): string {
    return this.theme.fg("dim", sharedFormatFeedLine(event));
  }

  private renderNoMessages(width: number, height: number, agents: AgentRegistration[]): string[] {
    const lines: string[] = [];

    if (this.selectedAgent === null) {
      const msg = "No broadcasts sent yet";
      const padTop = Math.floor((height - 1) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");
      const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg)) / 2)));
      lines.push(pad + this.theme.fg("dim", msg));
    } else {
      const agent = agents.find(a => a.name === this.selectedAgent);
      const msg1 = `No messages with ${this.selectedAgent}`;

      const details: string[] = [];
      if (agent) {
        const folder = extractFolder(agent.cwd);
        const infoParts = [folder];
        if (agent.gitBranch) infoParts.push(agent.gitBranch);
        infoParts.push(agent.model);
        infoParts.push(formatRelativeTime(agent.startedAt));
        details.push(infoParts.join(" • "));

        if (agent.reservations && agent.reservations.length > 0) {
          for (const r of agent.reservations) {
            details.push(`🔒 ${truncatePathLeft(r.pattern, 40)}`);
          }
        }
      }

      const totalLines = 1 + details.length + 1;
      const padTop = Math.floor((height - totalLines) / 2);
      for (let i = 0; i < padTop; i++) lines.push("");

      const pad1 = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(msg1)) / 2)));
      lines.push(pad1 + msg1);
      lines.push("");

      for (const detail of details) {
        const pad = " ".repeat(Math.max(0, Math.floor((width - visibleWidth(detail)) / 2)));
        lines.push(pad + this.theme.fg("dim", detail));
      }
    }

    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderMessageBox(msg: AgentMailMessage, maxWidth: number): string[] {
    const isOutgoing = msg.from === this.state.agentName;
    const senderLabel = isOutgoing
      ? (msg.to === "broadcast" ? "You → All" : "You")
      : stripAnsiCodes(msg.from);
    const senderColored = isOutgoing
      ? this.theme.fg("accent", senderLabel)
      : coloredAgentName(msg.from);

    const timeStr = formatRelativeTime(msg.timestamp);
    const time = this.theme.fg("dim", timeStr);
    const safeText = stripAnsiCodes(msg.text);

    const boxWidth = Math.max(6, Math.min(maxWidth, 60));
    const contentWidth = Math.max(1, boxWidth - 4);

    const wrappedLines = this.wrapText(safeText, contentWidth);

    const headerLeft = `┌─ ${senderColored} `;
    const headerRight = ` ${time} ─┐`;
    const headerLeftLen = 4 + visibleWidth(senderLabel);
    const headerRightLen = visibleWidth(timeStr) + 4;
    const dashCount = Math.max(0, boxWidth - headerLeftLen - headerRightLen);

    const lines: string[] = [];
    lines.push(headerLeft + "─".repeat(dashCount) + headerRight);

    for (const line of wrappedLines) {
      const padRight = contentWidth - visibleWidth(line);
      lines.push(`│ ${line}${" ".repeat(Math.max(0, padRight))} │`);
    }

    lines.push(`└${"─".repeat(Math.max(0, boxWidth - 2))}┘`);
    lines.push("");

    return lines;
  }

  private wrapText(text: string, maxWidth: number): string[] {
    const result: string[] = [];
    const paragraphs = text.split("\n");

    for (const para of paragraphs) {
      if (para === "") {
        result.push("");
        continue;
      }

      const words = para.split(" ");
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (visibleWidth(testLine) <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) result.push(currentLine);
          if (visibleWidth(word) > maxWidth) {
            currentLine = truncateToWidth(word, maxWidth - 1) + "…";
          } else {
            currentLine = word;
          }
        }
      }

      if (currentLine) result.push(currentLine);
    }

    return result.length > 0 ? result : [""];
  }

  private renderInputBar(width: number): string {
    // Crew tab has a status bar instead of input
    if (this.selectedAgent === CREW_TAB) {
      return renderCrewStatusBar(this.theme, this.cwd, width);
    }

    const prompt = this.theme.fg("accent", "> ");

    let placeholder: string;
    if (this.selectedAgent === AGENTS_TAB) {
      placeholder = "@name msg or broadcast...";
    } else if (this.selectedAgent === null) {
      placeholder = "Broadcast to all agents...";
    } else {
      placeholder = `Message ${this.selectedAgent}...`;
    }

    const hint = this.theme.fg("dim", "[Tab] [Enter]");
    const hintLen = visibleWidth("[Tab] [Enter]");

    if (this.inputText) {
      const maxInputLen = Math.max(1, width - 2 - hintLen - 2);
      const displayText = truncateToWidth(this.inputText, maxInputLen);
      const padLen = width - 2 - visibleWidth(displayText) - hintLen;
      return prompt + displayText + " ".repeat(Math.max(0, padLen)) + hint;
    } else {
      const displayPlaceholder = truncateToWidth(placeholder, Math.max(1, width - 2 - hintLen - 2));
      const padLen = width - 2 - visibleWidth(displayPlaceholder) - hintLen;
      return prompt + this.theme.fg("dim", displayPlaceholder) + " ".repeat(Math.max(0, padLen)) + hint;
    }
  }

  invalidate(): void {
    // No cached state to invalidate
  }

  dispose(): void {
    this.stopProgressRefresh();
    this.progressUnsubscribe?.();
    this.progressUnsubscribe = null;
  }
}
