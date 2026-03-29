import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  claimTask,
  completeTask,
  getAgentCurrentClaim,
  getClaims,
  getCompletions,
  isClaimAlreadyClaimed,
  isClaimAlreadyHaveClaim,
  isClaimSuccess,
  isCompleteSuccess,
  isUnclaimSuccess,
  unclaimTask,
} from '../store.js';
import { createMessengerFixture, writeRegistration } from './helpers/messenger-fixtures.js';

describe('store legacy claims', () => {
  it('claims, completes, and records legacy spec tasks', async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-legacy-claims-');
    const spec = path.join(cwd, 'spec.md');
    fs.writeFileSync(spec, '# Spec\n');

    writeRegistration(dirs, { name: 'AgentA', cwd, sessionId: 'session-a' });

    const claimed = await claimTask(
      dirs,
      spec,
      'task-1',
      'AgentA',
      'session-a',
      process.pid,
      'investigate'
    );
    expect(isClaimSuccess(claimed)).toBe(true);
    expect(getAgentCurrentClaim(dirs, 'AgentA')).toEqual({
      spec,
      taskId: 'task-1',
      reason: 'investigate',
    });

    const completed = await completeTask(dirs, spec, 'task-1', 'AgentA', 'done');
    expect(isCompleteSuccess(completed)).toBe(true);
    expect(getClaims(dirs)).toEqual({});
    expect(getCompletions(dirs)[spec]?.['task-1']?.completedBy).toBe('AgentA');
  });

  it('rejects duplicate claims and multiple simultaneous claims by the same agent', async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-legacy-conflict-');
    const specA = path.join(cwd, 'spec-a.md');
    const specB = path.join(cwd, 'spec-b.md');
    fs.writeFileSync(specA, '# A\n');
    fs.writeFileSync(specB, '# B\n');

    writeRegistration(dirs, { name: 'AgentA', cwd, sessionId: 'session-a' });
    writeRegistration(dirs, { name: 'AgentB', cwd, sessionId: 'session-b' });

    const first = await claimTask(dirs, specA, 'task-1', 'AgentA', 'session-a', process.pid);
    expect(isClaimSuccess(first)).toBe(true);

    const duplicate = await claimTask(
      dirs,
      specA,
      'task-1',
      'AgentB',
      'session-b',
      process.pid + 1
    );
    expect(isClaimAlreadyClaimed(duplicate)).toBe(true);
    if (isClaimAlreadyClaimed(duplicate)) {
      expect(duplicate.conflict.agent).toBe('AgentA');
    }

    const second = await claimTask(dirs, specB, 'task-2', 'AgentA', 'session-a', process.pid);
    expect(isClaimAlreadyHaveClaim(second)).toBe(true);
    if (isClaimAlreadyHaveClaim(second)) {
      expect(second.existing).toEqual({ spec: specA, taskId: 'task-1' });
    }
  });

  it('filters stale claims when the registry entry is missing or session ids diverge', async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-legacy-stale-');
    const spec = path.join(cwd, 'spec.md');
    fs.writeFileSync(spec, '# Spec\n');

    const staleClaim = {
      [spec]: {
        'task-1': {
          agent: 'Ghost',
          sessionId: 'session-old',
          pid: process.pid,
          claimedAt: new Date().toISOString(),
        },
      },
    };
    fs.writeFileSync(path.join(dirs.base, 'claims.json'), JSON.stringify(staleClaim, null, 2));

    expect(getClaims(dirs)).toEqual({});

    writeRegistration(dirs, { name: 'Ghost', cwd, sessionId: 'session-new' });
    fs.writeFileSync(path.join(dirs.base, 'claims.json'), JSON.stringify(staleClaim, null, 2));

    expect(getClaims(dirs)).toEqual({});
  });

  it("unclaims only the claiming agent's task", async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-legacy-unclaim-');
    const spec = path.join(cwd, 'spec.md');
    fs.writeFileSync(spec, '# Spec\n');

    writeRegistration(dirs, { name: 'AgentA', cwd, sessionId: 'session-a' });
    writeRegistration(dirs, { name: 'AgentB', cwd, sessionId: 'session-b' });

    await claimTask(dirs, spec, 'task-1', 'AgentA', 'session-a', process.pid);

    const denied = await unclaimTask(dirs, spec, 'task-1', 'AgentB');
    expect(isUnclaimSuccess(denied)).toBe(false);
    expect(getClaims(dirs)[spec]?.['task-1']?.agent).toBe('AgentA');

    const released = await unclaimTask(dirs, spec, 'task-1', 'AgentA');
    expect(isUnclaimSuccess(released)).toBe(true);
    expect(getClaims(dirs)).toEqual({});
  });
});
