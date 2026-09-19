import { describe, expect, it, vi } from 'vitest';
import { handleOverlayInput } from '../overlay/input.js';
import { createMessengerViewState } from '../overlay/actions.js';
import { createMessengerFixture, createState } from './helpers/messenger-fixtures.js';

describe('overlay input smoke', () => {
  it('toggles expanded feed rendering and requests a re-render', () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-overlay-input-');
    const viewState = createMessengerViewState();
    const state = createState('AgentA', { registered: true, currentChannel: 'general' });
    const requestRender = vi.fn();

    handleOverlayInput({
      data: 'e',
      width: 80,
      viewState,
      cwd,
      state,
      dirs,
      tui: { requestRender } as any,
      done: vi.fn(),
      currentChannel: () => 'general',
      cycleChannel: vi.fn(),
      generateSnapshot: () => 'snapshot',
      cancelCompletionTimer: vi.fn(),
      estimateFeedViewportHeight: () => 10,
      ensureFeedWindowInitialized: vi.fn(),
      getRenderedFeedLineCount: () => 10,
    });

    expect(viewState.expandFeedMessages).toBe(true);
    expect(requestRender).toHaveBeenCalled();
  });

  it('emits a snapshot when the transfer hotkey is pressed', () => {
    const { cwd, dirs } = createMessengerFixture('pi-messenger-overlay-snapshot-');
    const viewState = createMessengerViewState();
    const state = createState('AgentA', { registered: true, currentChannel: 'general' });
    const done = vi.fn();

    handleOverlayInput({
      data: 'T',
      width: 80,
      viewState,
      cwd,
      state,
      dirs,
      tui: { requestRender: vi.fn() } as any,
      done,
      currentChannel: () => 'general',
      cycleChannel: vi.fn(),
      generateSnapshot: () => 'snapshot text',
      cancelCompletionTimer: vi.fn(),
      estimateFeedViewportHeight: () => 10,
      ensureFeedWindowInitialized: vi.fn(),
      getRenderedFeedLineCount: () => 10,
    });

    expect(done).toHaveBeenCalledWith('snapshot text');
  });
});
