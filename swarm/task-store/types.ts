import type { SwarmTaskEvidence } from '../types.js';

// =============================================================================
// Task Event Sourcing Types
// =============================================================================

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'released'
  | 'progress'
  | 'completed'
  | 'blocked'
  | 'unblocked'
  | 'reset'
  | 'archived';

export interface TaskEvent {
  taskId: string;
  type: TaskEventType;
  timestamp: string;
  agent?: string; // Who performed the action
  channel?: string; // Original channel (for reference)
  payload?: unknown; // Type-specific data
}

// Event payloads
export interface CreatedPayload {
  title: string;
  content?: string;
  dependsOn?: string[];
  createdBy?: string;
}

export interface ClaimedPayload {
  previousAgent?: string;
  reason?: string;
}

export interface ProgressPayload {
  message: string;
  tokens?: number;
  toolCalls?: number;
}

export interface CompletedPayload {
  summary: string;
  evidence?: SwarmTaskEvidence;
}

export interface BlockedPayload {
  reason: string;
  blockedBy?: string;
}
