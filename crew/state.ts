/**
 * Crew - Shared Autonomous State
 * 
 * Tracks autonomous mode execution across turns.
 */

export interface WaveResult {
  waveNumber: number;
  tasksAttempted: string[];
  succeeded: string[];
  failed: string[];
  blocked: string[];
  timestamp: string;
}

export interface AutonomousState {
  active: boolean;
  cwd: string | null;
  waveNumber: number;
  waveHistory: WaveResult[];
  startedAt: string | null;
  stoppedAt: string | null;
  stopReason: "completed" | "blocked" | "manual" | null;
}

/**
 * Shared state for autonomous mode.
 * Persisted to session via appendEntry("crew-state", ...) and
 * restored on session_start.
 */
export const autonomousState: AutonomousState = {
  active: false,
  cwd: null,
  waveNumber: 0,
  waveHistory: [],
  startedAt: null,
  stoppedAt: null,
  stopReason: null,
};

export function startAutonomous(cwd: string): void {
  autonomousState.active = true;
  autonomousState.cwd = cwd;
  autonomousState.waveNumber = 1;
  autonomousState.waveHistory = [];
  autonomousState.startedAt = new Date().toISOString();
  autonomousState.stoppedAt = null;
  autonomousState.stopReason = null;
}

export function stopAutonomous(reason: "completed" | "blocked" | "manual"): void {
  autonomousState.active = false;
  autonomousState.stoppedAt = new Date().toISOString();
  autonomousState.stopReason = reason;
}

export function addWaveResult(result: WaveResult): void {
  autonomousState.waveHistory.push(result);
  autonomousState.waveNumber++;
}

export function restoreAutonomousState(data: Partial<AutonomousState>): void {
  if (data.active !== undefined) autonomousState.active = data.active;
  if (data.cwd !== undefined) autonomousState.cwd = data.cwd;
  if (data.waveNumber !== undefined) autonomousState.waveNumber = data.waveNumber;
  if (data.waveHistory !== undefined) autonomousState.waveHistory = data.waveHistory;
  if (data.startedAt !== undefined) autonomousState.startedAt = data.startedAt;
  if (data.stoppedAt !== undefined) autonomousState.stoppedAt = data.stoppedAt;
  if (data.stopReason !== undefined) autonomousState.stopReason = data.stopReason;
}


