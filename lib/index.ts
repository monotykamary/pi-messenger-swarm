// Re-export all lib modules
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
} from './types.js';

export {
  computeStatus,
  formatDuration,
  STATUS_INDICATORS,
  generateAutoStatus,
  buildSelfRegistration,
  agentHasTask,
} from './status.js';

export {
  generateMemorableName,
  isValidAgentName,
  agentColorCode,
  coloredAgentName,
} from './names.js';

export {
  extractFolder,
  resolveSpecPath,
  displaySpecPath,
  truncatePathLeft,
  pathMatchesReservation,
} from './paths.js';

export { isProcessAlive, formatRelativeTime, stripAnsiCodes } from './format.js';

// Constants
export const MAX_CHAT_HISTORY = 50;
