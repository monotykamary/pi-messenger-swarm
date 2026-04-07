import type * as fs from 'node:fs';

// =============================================================================
// Core Types
// =============================================================================

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export interface AgentSession {
  toolCalls: number;
  tokens: number;
  filesModified: string[];
}

export interface AgentActivity {
  lastActivityAt: string;
  currentActivity?: string;
  lastToolCall?: string;
}

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  cwd: string;
  model: string;
  startedAt: string;
  reservations?: FileReservation[];
  gitBranch?: string;
  spec?: string;
  isHuman: boolean;
  session: AgentSession;
  activity: AgentActivity;
  statusMessage?: string;
  currentChannel?: string;
  sessionChannel?: string;
  joinedChannels?: string[];
}

export interface AgentMailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  timestamp: string;
  replyTo: string | null;
  channel?: string;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export interface MessengerState {
  agentName: string;
  registered: boolean;
  reservations: FileReservation[];
  chatHistory: Map<string, AgentMailMessage[]>;
  unreadCounts: Map<string, number>;
  channelPostHistory: AgentMailMessage[];
  seenSenders: Map<string, string>;
  model: string;
  gitBranch?: string;
  spec?: string;
  scopeToFolder: boolean;
  isHuman: boolean;
  session: AgentSession;
  activity: AgentActivity;
  statusMessage?: string;
  customStatus: boolean;
  registryFlushTimer: ReturnType<typeof setTimeout> | null;
  sessionStartedAt: string;
  contextSessionId?: string;
  currentChannel: string;
  sessionChannel: string;
  joinedChannels: string[];
}

export interface Dirs {
  base: string;
  registry: string;
}

export type AgentStatus = 'active' | 'idle' | 'away' | 'stuck';

export interface ComputedStatus {
  status: AgentStatus;
  idleFor?: string;
}

export interface NameThemeConfig {
  theme: string;
  customWords?: { adjectives: string[]; nouns: string[] };
}

export interface AutoStatusContext {
  currentActivity?: string;
  recentCommit: boolean;
  recentTestRuns: number;
  recentEdits: number;
  sessionStartedAt: string;
}
