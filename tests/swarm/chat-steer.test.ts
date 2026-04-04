import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@mariozechner/pi-tui', () => ({
  matchesKey: (data: string, key: string) => {
    if (key === 'escape') return data === '\x1b';
    if (key === 'enter') return data === '\r';
    if (key === 'backspace') return data === '\x7f' || data === '\b';
    if (key === 'tab') return data === '\t';
    if (key === 'shift+tab') return data === '\x1b[Z';
    return false;
  },
}));

const mocks = vi.hoisted(() => ({
  sendMessageToAgent: vi.fn(),
  getActiveAgents: vi.fn(),
  resolveTargetChannel: vi.fn(),
  logFeedEvent: vi.fn(),
}));

vi.mock('../../store.js', () => ({
  sendMessageToAgent: mocks.sendMessageToAgent,
  getActiveAgents: mocks.getActiveAgents,
  resolveTargetChannel: mocks.resolveTargetChannel,
}));

vi.mock('../../swarm/live-progress.js', () => ({
  getLiveWorkers: () => new Map(),
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));

vi.mock('../../feed.js', () => ({
  logFeedEvent: mocks.logFeedEvent,
}));

vi.mock('../../swarm/task-actions.js', () => ({
  executeTaskAction: () => ({ success: true, message: 'ok' }),
}));

import { createMessengerViewState, handleMessageInput } from '../../overlay-actions.js';
import type { MessengerState, Dirs } from '../../lib.js';
import type { TUI } from '@mariozechner/pi-tui';

function makeState(): MessengerState {
  return {
    agentName: 'me',
    scopeToFolder: false,
    chatHistory: new Map(),
    channelPostHistory: [],
    currentChannel: 'general',
    sessionChannel: 'general',
    joinedChannels: ['general'],
  } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: '/tmp', registry: '/tmp/reg', inbox: '/tmp/inbox' } as Dirs;
}

function makeTui(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

describe('overlay chat steering behavior', () => {
  beforeEach(() => {
    mocks.sendMessageToAgent.mockReset();
    mocks.getActiveAgents.mockReset();
    mocks.resolveTargetChannel.mockReset();
    mocks.logFeedEvent.mockReset();
  });

  it('posts to the current session channel when no peers are present', () => {
    const viewState = createMessengerViewState();
    viewState.inputMode = 'message';
    viewState.messageInput = 'Investigate auth race';

    const state = makeState();
    const dirs = makeDirs();
    const tui = makeTui();

    mocks.getActiveAgents.mockReturnValue([]);

    handleMessageInput('\r', viewState, state, dirs, '/tmp/cwd', tui);

    expect(mocks.sendMessageToAgent).not.toHaveBeenCalled();
    expect(mocks.logFeedEvent).toHaveBeenCalledWith(
      '/tmp/cwd',
      'me',
      'message',
      undefined,
      'Investigate auth race',
      'general'
    );
    expect(viewState.inputMode).toBe('normal');
    expect(viewState.messageInput).toBe('');
  });

  it('posts to detached channels even when no peers are present', () => {
    const viewState = createMessengerViewState();
    viewState.inputMode = 'message';
    viewState.messageInput = 'Remember this';

    const state = makeState();
    state.currentChannel = 'memory';
    state.joinedChannels = ['general', 'memory'];
    const dirs = makeDirs();
    const tui = makeTui();

    mocks.getActiveAgents.mockReturnValue([]);

    handleMessageInput('\r', viewState, state, dirs, '/tmp/cwd', tui);

    expect(mocks.sendMessageToAgent).not.toHaveBeenCalled();
    expect(mocks.logFeedEvent).toHaveBeenCalledWith(
      '/tmp/cwd',
      'me',
      'message',
      undefined,
      'Remember this',
      'memory'
    );
    expect(viewState.inputMode).toBe('normal');
    expect(viewState.messageInput).toBe('');
  });

  it('posts to feed when peers exist (no more DM delivery)', () => {
    const viewState = createMessengerViewState();
    viewState.inputMode = 'message';
    viewState.messageInput = 'Hello swarm';

    const state = makeState();
    const dirs = makeDirs();
    const tui = makeTui();

    mocks.getActiveAgents.mockReturnValue([{ name: 'alpha' }, { name: 'beta' }]);

    handleMessageInput('\r', viewState, state, dirs, '/tmp/cwd', tui);

    // With feed-based messaging only, no DM delivery happens
    expect(mocks.sendMessageToAgent).not.toHaveBeenCalled();
    expect(mocks.logFeedEvent).toHaveBeenCalledWith(
      '/tmp/cwd',
      'me',
      'message',
      undefined,
      'Hello swarm',
      'general'
    );
    expect(viewState.inputMode).toBe('normal');
    expect(viewState.messageInput).toBe('');
  });
});
