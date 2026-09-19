// Re-export for backwards compatibility
// Inlined from ./lib/index.js to avoid a .js -> .ts resolution failure
// when jiti loads this file from source (index.ts fallback path).
export type {
  FileReservation,
  AgentSession,
  AgentActivity,
  AgentRegistration,
  AgentMailMessage,
  ReservationConflict,
  MessengerState,
  Dirs,
  AgentStatus,
  ComputedStatus,
  NameThemeConfig,
  AutoStatusContext,
} from './lib/types.js';

export {
  computeStatus,
  formatDuration,
  STATUS_INDICATORS,
  generateAutoStatus,
  buildSelfRegistration,
  agentHasTask,
} from './lib/status.js';

export {
  generateMemorableName,
  isValidAgentName,
  agentColorCode,
  coloredAgentName,
} from './lib/names.js';

export {
  extractFolder,
  resolveSpecPath,
  displaySpecPath,
  truncatePathLeft,
  pathMatchesReservation,
} from './lib/paths.js';

export { isProcessAlive, formatRelativeTime, stripAnsiCodes } from './lib/format.js';

// Constants
export const MAX_CHAT_HISTORY = 50;
