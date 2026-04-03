import { describe, expect, it, vi } from 'vitest';
import type { ExtensionContext } from '@mariozechner/pi-coding-agent';
import { createStatusController } from '../extension/status.js';
import * as swarmStore from '../swarm/store.js';
import {
  createMessengerFixture,
  createState,
  writeRegistration,
} from './helpers/messenger-fixtures.js';

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

describe('extension status controller', () => {
  it('updates status text and drops unread counts for inactive senders', () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-status-');
    const state = createState('AgentA', {
      registered: true,
      currentChannel: 'general',
      sessionChannel: 'general',
      joinedChannels: ['general', 'memory'],
      activity: { lastActivityAt: new Date().toISOString(), currentActivity: 'editing index.ts' },
    });
    state.unreadCounts.set('Peer', 1);
    state.unreadCounts.set('Ghost', 2);

    writeRegistration(dirs, {
      name: 'Peer',
      cwd,
      sessionId: 'session-peer',
      currentChannel: 'general',
      sessionChannel: 'general',
      joinedChannels: ['general', 'memory'],
    });
    swarmStore.createTask(cwd, { title: 'Task' }, 'general');

    const setStatus = vi.fn();
    const maybeAutoOpenSwarmOverlay = vi.fn();
    const ctx = {
      hasUI: true,
      cwd,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: vi.fn(),
        setStatus,
        custom: vi.fn(),
      } as unknown as ExtensionContext['ui'],
    } as ExtensionContext;

    const controller = createStatusController({
      state,
      dirs,
      config: baseConfig,
      maybeAutoOpenSwarmOverlay,
    });

    controller.updateStatus(ctx);

    expect(state.unreadCounts.has('Ghost')).toBe(false);
    expect(setStatus).toHaveBeenCalledWith(
      'messenger',
      expect.stringContaining('msg: AgentA (1 peer) ●1 · editing index.ts ☑ 0/1 tasks')
    );
    expect(maybeAutoOpenSwarmOverlay).toHaveBeenCalledWith(ctx);
  });
});
