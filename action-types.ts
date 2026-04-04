export interface TaskEvidence {
  commits?: string[];
  tests?: string[];
  prs?: string[];
}

export interface MessengerActionParams {
  // Action
  action?: string;

  // Task IDs
  id?: string;
  taskId?: string;

  // Task creation & lifecycle
  title?: string;
  content?: string;
  dependsOn?: string[];
  summary?: string;
  evidence?: TaskEvidence;
  cascade?: boolean;

  // Generic text payloads
  prompt?: string;
  message?: string;
  reason?: string;

  // Coordination
  to?: string | string[];
  replyTo?: string;
  paths?: string[];
  name?: string;
  channel?: string;
  create?: boolean;
  limit?: number;
  autoRegisterPath?: 'add' | 'remove' | 'list';
  spec?: string; // Spec file path for join action

  // Spawn
  role?: string;
  persona?: string;
  model?: string;
  agentFile?: string;
}
