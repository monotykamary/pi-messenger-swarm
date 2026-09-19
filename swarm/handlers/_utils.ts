import * as taskStore from '../task-store.js';

export function summaryLine(cwd: string, sessionId: string): string {
  const s = taskStore.getSummary(cwd, sessionId);
  return `${s.done}/${s.total} done · ${s.in_progress} in progress · ${s.todo} todo · ${s.blocked} blocked`;
}
