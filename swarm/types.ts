export type SwarmTaskStatus = "todo" | "in_progress" | "done" | "blocked";

export interface SwarmTaskEvidence {
  commits?: string[];
  tests?: string[];
  prs?: string[];
}

export interface SwarmTask {
  id: string;
  title: string;
  status: SwarmTaskStatus;
  depends_on: string[];
  created_at: string;
  updated_at: string;
  created_by?: string;
  claimed_by?: string;
  claimed_at?: string;
  completed_by?: string;
  completed_at?: string;
  summary?: string;
  evidence?: SwarmTaskEvidence;
  blocked_reason?: string;
  attempt_count: number;
}

export interface SwarmTaskCreateInput {
  title: string;
  content?: string;
  dependsOn?: string[];
  createdBy?: string;
}

export interface SwarmSummary {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  blocked: number;
}

export interface SpawnRequest {
  role: string;
  persona?: string;
  objective: string;
  context?: string;
  taskId?: string;
  model?: string;
  name?: string;
}

export interface SpawnedAgent {
  id: string;
  cwd: string;
  name: string;
  role: string;
  persona?: string;
  objective: string;
  context?: string;
  taskId?: string;
  model?: string;
  status: "running" | "completed" | "failed" | "stopped";
  startedAt: string;
  endedAt?: string;
  exitCode?: number;
  error?: string;
}
