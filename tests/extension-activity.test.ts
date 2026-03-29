import { describe, expect, it } from 'vitest';
import { createActivityTracker } from '../extension/activity.js';
import {
  createMessengerFixture,
  createContext,
  createState,
} from './helpers/messenger-fixtures.js';
import { readFeedEvents } from '../feed.js';

const baseConfig = {
  autoRegister: false,
  autoRegisterPaths: [],
  scopeToFolder: false,
  contextMode: 'full' as const,
  registrationContext: true,
  replyHint: true,
  senderDetailsOnFirstContact: true,
  nameTheme: 'default',
  feedRetention: 50,
  stuckThreshold: 900,
  stuckNotify: true,
  autoStatus: true,
  autoOverlay: true,
  swarmEventsInFeed: true,
};

describe('extension activity tracker', () => {
  it('tracks edits, reads, commits, tests, and auto-status', async () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-activity-');
    const ctx = createContext(cwd, 'session-activity', false);
    const state = createState('AgentA', {
      registered: true,
      currentChannel: 'general',
      sessionStartedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    const tracker = createActivityTracker({ state, dirs, config: baseConfig });
    try {
      await tracker.handleToolCall({ toolName: 'read', input: { path: 'src/index.ts' } }, ctx);
      expect(state.activity.currentActivity).toBe('reading src/index.ts');
      expect(state.statusMessage).toBe('exploring the codebase');

      await tracker.handleToolCall({ toolName: 'write', input: { path: 'src/output.ts' } }, ctx);
      expect(state.activity.currentActivity).toBe('editing src/output.ts');

      await tracker.handleToolResult({ toolName: 'write', input: { path: 'src/output.ts' } }, ctx);
      expect(state.activity.lastToolCall).toBe('write: src/output.ts');
      expect(state.session.filesModified).toContain('src/output.ts');

      await tracker.handleToolResult(
        { toolName: 'bash', input: { command: 'git commit -m "ship it"' }, isError: false },
        ctx
      );
      await tracker.handleToolResult(
        { toolName: 'bash', input: { command: 'npm test' }, isError: false },
        ctx
      );

      const feed = readFeedEvents(cwd, 20, 'general');
      expect(feed.some((event) => event.type === 'commit' && event.preview === 'ship it')).toBe(
        true
      );
      expect(feed.some((event) => event.type === 'test' && event.preview === 'passed')).toBe(true);
      expect(state.activity.currentActivity).toBeUndefined();
    } finally {
      tracker.dispose();
    }
  });
});
