import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeClaim, executeComplete, executeSetSpec } from '../handlers.js';
import {
  createContext,
  createMessengerFixture,
  createState,
  writeRegistration,
} from './helpers/messenger-fixtures.js';

describe('handlers legacy compatibility', () => {
  it('supports legacy spec-based claim and complete flows', async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-handlers-legacy-');
    const ctx = createContext(cwd, 'session-legacy', false);
    const spec = path.join(cwd, 'legacy-spec.md');
    fs.writeFileSync(spec, '# Legacy\n');

    const state = createState('AgentA', {
      registered: true,
      currentChannel: 'general',
      sessionChannel: 'general',
      joinedChannels: ['general', 'memory', 'heartbeat'],
    });
    writeRegistration(dirs, {
      name: 'AgentA',
      cwd,
      sessionId: 'session-legacy',
      spec,
      currentChannel: 'general',
    });

    const setSpec = executeSetSpec(state, dirs, ctx, spec);
    expect(setSpec.content[0]?.text).toContain('Spec set to');

    const claimed = await executeClaim(state, dirs, ctx, 'task-1');
    expect(claimed.content[0]?.text).toContain('Claimed task-1');
    expect(claimed.details.mode).toBe('claim');

    const completed = await executeComplete(state, dirs, 'task-1', 'done');
    expect(completed.content[0]?.text).toContain('Completed task-1');
    expect(completed.details.mode).toBe('complete');
  });

  it('returns a clear legacy claim error when no spec is registered', async () => {
    const { dirs } = createMessengerFixture('pi-messenger-handlers-no-spec-');
    const state = createState('AgentA', { registered: true });
    const ctx = createContext(process.cwd(), 'session-legacy', false);

    const result = await executeClaim(state, dirs, ctx, 'task-1');
    expect(result.content[0]?.text).toContain('No spec registered');
    expect(result.details.error).toBe('no_spec');
  });
});
