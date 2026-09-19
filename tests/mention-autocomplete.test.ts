import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@earendil-works/pi-tui', () => ({
  matchesKey: (data: string, key: string) => {
    if (key === 'escape') return data === '\x1b';
    if (key === 'enter') return data === '\r';
    if (key === 'backspace') return data === '\x7f' || data === '\b';
    if (key === 'tab') return data === '\t';
    if (key === 'shift+tab') return data === '\x1b[Z';
    return false;
  },
  truncateToWidth: (s: string) => s,
  visibleWidth: (s: string) => s.length,
}));

import {
  createMessengerViewState,
  handleMessageInput,
  type MessengerViewState,
} from '../overlay/actions.js';
import type { MessengerState, Dirs } from '../lib.js';
import type { TUI } from '@earendil-works/pi-tui';

vi.mock('../store.js', () => ({
  getActiveAgents: () => [{ name: 'coral-fox' }, { name: 'amber-wolf' }, { name: 'crimson-bear' }],
  sendMessageToAgent: vi.fn(),
  getClaims: () => ({}),
}));

vi.mock('../channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel.js')>();
  return {
    ...actual,
    agentNameToChannelId: (name: string) => name.toLowerCase(),
  };
});

const liveWorkersMock = vi.hoisted(() =>
  vi.fn(() => new Map([['task-1', { name: 'jade-elk', taskId: 'task-1', pid: process.pid }]]))
);

vi.mock('../swarm/live-progress.js', () => ({
  getLiveWorkers: liveWorkersMock,
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));

vi.mock('../lib.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib.js')>();
  return { ...actual, isProcessAlive: (pid: number) => pid === process.pid };
});

vi.mock('../feed/index.js', () => ({
  logFeedEvent: vi.fn(),
  readFeedEvents: () => [],
}));

function makeState(): MessengerState {
  return { agentName: 'me', scopeToFolder: false } as MessengerState;
}

function makeDirs(): Dirs {
  return { base: '/tmp', registry: '/tmp/reg' };
}

function makeTui(): TUI {
  return { requestRender: vi.fn() } as unknown as TUI;
}

function sendTab(vs: MessengerViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput('\t', vs, state, dirs, '/tmp/cwd', tui);
}

function sendShiftTab(vs: MessengerViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput('\x1b[Z', vs, state, dirs, '/tmp/cwd', tui);
}

function type(char: string, vs: MessengerViewState, state: MessengerState, dirs: Dirs, tui: TUI) {
  handleMessageInput(char, vs, state, dirs, '/tmp/cwd', tui);
}

describe('channel autocomplete', () => {
  let vs: MessengerViewState;
  let state: MessengerState;
  let dirs: Dirs;
  let tui: TUI;

  beforeEach(() => {
    vs = createMessengerViewState();
    vs.inputMode = 'message';
    state = makeState();
    dirs = makeDirs();
    tui = makeTui();
  });

  it('tab completes first matching channel after #', () => {
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toMatch(/^#\S+ $/);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    expect(vs.mentionIndex).toBe(0);
  });

  it('cycles through candidates on repeated tab', () => {
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    const first = vs.messageInput;
    sendTab(vs, state, dirs, tui);
    const second = vs.messageInput;
    expect(second).not.toBe(first);
    expect(vs.mentionIndex).toBe(1);
  });

  it('shift+tab cycles backwards', () => {
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    sendTab(vs, state, dirs, tui);
    const atTwo = vs.messageInput;
    sendShiftTab(vs, state, dirs, tui);
    const backOne = vs.messageInput;
    expect(vs.mentionIndex).toBe(0);
    expect(backOne).not.toBe(atTwo);
  });

  it('filters candidates by typed prefix', () => {
    vs.messageInput = '#cor';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#coral-fox ');
  });

  it('includes live workers in candidates', () => {
    vs.messageInput = '#jade';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#jade-elk ');
  });

  it('includes #all in candidates', () => {
    vs.messageInput = '#al';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#all ');
  });

  it('does not complete when input has a space (message already started)', () => {
    vs.messageInput = '#coral-fox hey';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#coral-fox hey');
  });

  it('resets candidates on backspace', () => {
    vs.messageInput = '#cor';
    sendTab(vs, state, dirs, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type('\b', vs, state, dirs, tui);
    expect(vs.mentionCandidates).toEqual([]);
    expect(vs.mentionIndex).toBe(-1);
  });

  it('resets candidates on new character typed', () => {
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    expect(vs.mentionCandidates.length).toBeGreaterThan(0);
    type('x', vs, state, dirs, tui);
    expect(vs.mentionCandidates).toEqual([]);
  });

  it('wraps around at end of candidates list', () => {
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    const count = vs.mentionCandidates.length;
    for (let i = 0; i < count; i++) sendTab(vs, state, dirs, tui);
    expect(vs.mentionIndex).toBe(0);
  });
});

describe('channel autocomplete — ghost live worker (stale dead-pid)', () => {
  let vs: MessengerViewState;
  let state: MessengerState;
  let dirs: Dirs;
  let tui: TUI;

  beforeEach(() => {
    vs = createMessengerViewState();
    vs.inputMode = 'message';
    state = makeState();
    dirs = makeDirs();
    tui = makeTui();
    // Reset to default (alive worker)
    liveWorkersMock.mockReturnValue(
      new Map([['task-1', { name: 'jade-elk', taskId: 'task-1', pid: process.pid }]])
    );
  });

  it('excludes a live worker whose pid is dead from Tab candidates', () => {
    // pid 99999999 is dead — isProcessAlive mock returns false for it
    liveWorkersMock.mockReturnValue(
      new Map([['task-dead', { name: 'swift-raven', taskId: 'task-dead', pid: 99999999 }]])
    );
    vs.messageInput = '#swift';
    sendTab(vs, state, dirs, tui);
    // No match — swift-raven should be filtered out
    expect(vs.messageInput).toBe('#swift');
    expect(vs.mentionCandidates).toEqual([]);
  });

  it('includes a live worker whose pid is alive in Tab candidates', () => {
    // jade-elk has process.pid — isProcessAlive returns true
    vs.messageInput = '#jade';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#jade-elk ');
  });

  it('a worker with no pid (legacy entry) is still included', () => {
    // No pid field — treat as alive for backward compat
    liveWorkersMock.mockReturnValue(
      new Map([['task-legacy', { name: 'old-worker', taskId: 'task-legacy' }]])
    );
    vs.messageInput = '#old';
    sendTab(vs, state, dirs, tui);
    expect(vs.messageInput).toBe('#old-worker ');
  });

  it('shows alive workers while filtering dead ones in the same map', () => {
    liveWorkersMock.mockReturnValue(
      new Map([
        ['task-dead', { name: 'swift-raven', taskId: 'task-dead', pid: 99999999 }],
        ['task-alive', { name: 'jade-elk', taskId: 'task-alive', pid: process.pid }],
      ])
    );
    vs.messageInput = '#';
    sendTab(vs, state, dirs, tui);
    expect(vs.mentionCandidates).not.toContain('swift-raven');
    expect(vs.mentionCandidates).toContain('jade-elk');
  });
});
