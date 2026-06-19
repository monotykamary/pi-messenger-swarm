import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  logFeedEvent: vi.fn(),
  getActiveAgents: vi.fn(),
  getAgentPreferredChannel: vi.fn(
    (reg: { currentChannel?: string }) => reg.currentChannel ?? 'unknown'
  ),
}));

vi.mock('../feed/index.js', () => ({
  logFeedEvent: mocks.logFeedEvent,
}));

vi.mock('../store/agents.js', () => ({
  getActiveAgents: mocks.getActiveAgents,
  getAgentPreferredChannel: mocks.getAgentPreferredChannel,
}));

import { handleHashInput } from '../extension/handle-input.js';
import type { MessengerState, Dirs } from '../lib.js';

function makeState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    agentName: 'TrueLion',
    registered: true,
    currentChannel: 'my-session',
    sessionChannel: 'my-session',
    joinedChannels: ['my-session', 'memory'],
    ...overrides,
  } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: '/tmp', registry: '/tmp/reg' };
}

describe('handleHashInput', () => {
  const notify = vi.fn();

  beforeEach(() => {
    mocks.logFeedEvent.mockReset();
    mocks.getActiveAgents.mockReset();
    mocks.getAgentPreferredChannel.mockReset();
    notify.mockReset();
    mocks.getAgentPreferredChannel.mockImplementation(
      (reg: { currentChannel?: string }) => reg.currentChannel ?? 'unknown'
    );
  });

  it('passes through regular messages', () => {
    const result = handleHashInput('hello world', makeState(), makeDirs(), '/cwd', notify);
    expect(result).toEqual({ action: 'continue' });
    expect(mocks.logFeedEvent).not.toHaveBeenCalled();
  });

  it('passes through bare # with no message', () => {
    const result = handleHashInput('# ', makeState(), makeDirs(), '/cwd', notify);
    expect(result).toEqual({ action: 'continue' });
  });

  it('passes through # with no space (incomplete channel)', () => {
    const result = handleHashInput('#all', makeState(), makeDirs(), '/cwd', notify);
    expect(result).toEqual({ action: 'continue' });
  });

  it('passes through when not registered', () => {
    const state = makeState({ registered: false });
    const result = handleHashInput('#all hi', state, makeDirs(), '/cwd', notify);
    expect(result).toEqual({ action: 'continue' });
    expect(mocks.logFeedEvent).not.toHaveBeenCalled();
  });

  describe('#all broadcast', () => {
    it('logs to current channel and each active agent channel', () => {
      mocks.getActiveAgents.mockReturnValue([
        { name: 'AgentA', currentChannel: 'session-a' },
        { name: 'AgentB', currentChannel: 'session-b' },
      ]);

      const result = handleHashInput(
        '#all hello everyone',
        makeState(),
        makeDirs(),
        '/cwd',
        notify
      );

      expect(result).toEqual({ action: 'handled' });
      // Should log to current channel + 2 agent channels = 3 unique channels
      expect(mocks.logFeedEvent).toHaveBeenCalledTimes(3);
      expect(mocks.logFeedEvent).toHaveBeenCalledWith(
        '/cwd',
        'TrueLion',
        'message',
        '#all',
        'hello everyone',
        'my-session'
      );
      expect(mocks.logFeedEvent).toHaveBeenCalledWith(
        '/cwd',
        'TrueLion',
        'message',
        '#all',
        'hello everyone',
        'session-a'
      );
      expect(mocks.logFeedEvent).toHaveBeenCalledWith(
        '/cwd',
        'TrueLion',
        'message',
        '#all',
        'hello everyone',
        'session-b'
      );
    });

    it('deduplicates channels when agents share the same channel', () => {
      mocks.getActiveAgents.mockReturnValue([
        { name: 'AgentA', currentChannel: 'my-session' }, // same as human's channel
        { name: 'AgentB', currentChannel: 'session-b' },
      ]);

      handleHashInput('#all dedupe test', makeState(), makeDirs(), '/cwd', notify);

      // my-session counted once + session-b = 2 unique channels
      expect(mocks.logFeedEvent).toHaveBeenCalledTimes(2);
    });

    it('shows broadcast notification with agent count', () => {
      mocks.getActiveAgents.mockReturnValue([
        { name: 'AgentA', currentChannel: 'session-a' },
        { name: 'AgentB', currentChannel: 'session-b' },
      ]);

      handleHashInput('#all hi', makeState(), makeDirs(), '/cwd', notify);

      expect(notify).toHaveBeenCalledWith('Broadcast sent to 2 agents', 'info');
    });

    it('shows no-agents notice when mesh is empty', () => {
      mocks.getActiveAgents.mockReturnValue([]);

      handleHashInput('#all hi', makeState(), makeDirs(), '/cwd', notify);

      expect(notify).toHaveBeenCalledWith('Broadcast posted (no active agents)', 'info');
      // Still logs to current channel
      expect(mocks.logFeedEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('#channel targeted', () => {
    it('logs to the named channel', () => {
      mocks.getActiveAgents.mockReturnValue([]);

      const result = handleHashInput(
        '#memory remember this',
        makeState(),
        makeDirs(),
        '/cwd',
        notify
      );

      expect(result).toEqual({ action: 'handled' });
      expect(mocks.logFeedEvent).toHaveBeenCalledWith(
        '/cwd',
        'TrueLion',
        'message',
        undefined,
        'remember this',
        'memory'
      );
      expect(notify).toHaveBeenCalledWith('Sent to #memory', 'info');
    });

    it('handles multi-word messages', () => {
      mocks.getActiveAgents.mockReturnValue([]);

      handleHashInput('#dev please review this PR', makeState(), makeDirs(), '/cwd', notify);

      expect(mocks.logFeedEvent).toHaveBeenCalledWith(
        '/cwd',
        'TrueLion',
        'message',
        undefined,
        'please review this PR',
        'dev'
      );
    });

    it('rejects invalid channel names (e.g. containing special chars)', () => {
      const result = handleHashInput('#inval!d hi', makeState(), makeDirs(), '/cwd', notify);
      expect(result).toEqual({ action: 'continue' });
      expect(mocks.logFeedEvent).not.toHaveBeenCalled();
    });
  });
});
