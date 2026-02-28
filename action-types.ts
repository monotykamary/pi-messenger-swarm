export interface TaskEvidence {
  commits?: string[];
  tests?: string[];
  prs?: string[];
}

export interface MessengerActionParams {
  // Action
  action?: string;

  // Legacy plan fields (ignored in swarm mode, kept for compatibility)
  prd?: string;
  target?: string;
  type?: "plan" | "impl";
  autoWork?: boolean;
  autonomous?: boolean;
  concurrency?: number;
  count?: number;
  subtasks?: { title: string; content?: string }[];

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
  notes?: string;

  // Coordination
  to?: string | string[];
  replyTo?: string;
  paths?: string[];
  name?: string;
  spec?: string;
  limit?: number;
  autoRegisterPath?: "add" | "remove" | "list";

  // Spawn
  role?: string;
  persona?: string;
  model?: string;
}
