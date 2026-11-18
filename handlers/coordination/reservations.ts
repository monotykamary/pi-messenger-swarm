import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Dirs, MessengerState } from '../../lib.js';
import * as store from '../../store.js';
import { notRegisteredError, result } from '../result.js';

export function executeReserve(
  state: MessengerState,
  dirs: Dirs,
  _ctx: ExtensionContext,
  paths: string[],
  reason?: string
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const conflicts = store.getConflictsWithOtherAgents(paths[0] ?? '', state, dirs);
  if (conflicts.length > 0) {
    const conflictList = conflicts
      .map((c) => `  - ${c.agent}: ${c.pattern}${c.reason ? ` (${c.reason})` : ''}`)
      .join('\n');
    return result(`Cannot reserve: conflicting reservations found:\n${conflictList}`, {
      mode: 'reserve',
      error: 'conflict',
      conflicts,
    });
  }

  const saved = store.mutateReservations(state, dirs, (reservations) => {
    for (const pattern of paths) {
      reservations.push({ pattern, reason, since: new Date().toISOString() });
    }
    return true;
  });
  if (!saved)
    return result('Could not update reservations.', {
      mode: 'reserve',
      error: 'registration_write_failed',
    });

  const lines = ['Reserved paths:', ...paths.map((p) => `  - ${p}`)];
  if (reason) lines.push(`Reason: ${reason}`);

  return result(lines.join('\n'), { mode: 'reserve', paths, reason });
}

export function executeRelease(
  state: MessengerState,
  dirs: Dirs,
  _ctx: ExtensionContext,
  paths: string[] | true
) {
  if (!state.registered) {
    return notRegisteredError();
  }

  const released: string[] = [];
  const notFound: string[] = [];

  const saved = store.mutateReservations(state, dirs, (reservations) => {
    if (paths === true) {
      released.push(...reservations.map((r) => r.pattern));
      reservations.length = 0;
    } else {
      for (const pattern of paths) {
        const idx = reservations.findIndex((r) => r.pattern === pattern);
        if (idx >= 0) {
          reservations.splice(idx, 1);
          released.push(pattern);
        } else {
          notFound.push(pattern);
        }
      }
    }
    return true;
  });
  if (!saved)
    return result('Could not update reservations.', {
      mode: 'release',
      error: 'registration_write_failed',
    });

  const lines: string[] = [];
  if (released.length > 0) {
    lines.push('Released paths:', ...released.map((p) => `  - ${p}`));
  }
  if (notFound.length > 0) {
    lines.push('Not found:', ...notFound.map((p) => `  - ${p}`));
  }

  return result(lines.join('\n'), { mode: 'release', released, notFound });
}
