import { describe, expect, it } from 'vitest';
import { computeCompletionState, getSignificantEventMessage } from '../overlay/notifications.js';
import type { FeedEvent } from '../feed.js';

describe('overlay notifications litmus', () => {
  it('collapses repeated significant events into a concise summary', () => {
    const prevTs = '2026-01-01T00:00:00.000Z';
    const events: FeedEvent[] = [
      { ts: '2026-01-01T00:00:01.000Z', agent: 'Alice', type: 'task.done', target: 'task-1' },
      { ts: '2026-01-01T00:00:02.000Z', agent: 'Bob', type: 'task.done', target: 'task-2' },
    ];

    expect(getSignificantEventMessage(events, prevTs)).toBe('2 tasks completed');
  });

  it('formats single message events with preview text', () => {
    const prevTs = '2026-01-01T00:00:00.000Z';
    const events: FeedEvent[] = [
      { ts: '2026-01-01T00:00:01.000Z', agent: 'Alice', type: 'message', preview: 'Need review' },
    ];

    expect(getSignificantEventMessage(events, prevTs)).toBe('Alice — Need review');
  });

  it('reuses cached completion state when the task array is unchanged', () => {
    const tasks = [{ id: 'task-1', title: 'Done', status: 'done' }] as any;

    const first = computeCompletionState(tasks, null);
    const second = computeCompletionState(tasks, first);

    expect(first.allDone).toBe(true);
    expect(second.allDone).toBe(true);
    expect(second.tasks).toBe(tasks);
  });
});
