import type { FeedEvent, FeedEventType } from '../feed.js';
import type { SwarmTask as Task } from '../swarm/types.js';

const SIGNIFICANT_EVENTS = new Set<FeedEventType>([
  'task.done',
  'task.block',
  'task.start',
  'message',
  'task.reset',
  'task.unblock',
]);

export function getSignificantEventMessage(
  events: FeedEvent[],
  prevTs: string | null
): string | null {
  if (prevTs === null || events.length === 0) return null;
  const newestTs = events[events.length - 1]?.ts;
  if (!newestTs || newestTs <= prevTs) return null;

  const newEvents = events.filter((e) => e.ts > prevTs);
  if (newEvents.length === 0) return null;

  const significant = newEvents.filter((e) => SIGNIFICANT_EVENTS.has(e.type));
  if (significant.length === 0) return null;

  const last = significant[significant.length - 1];
  const sameType = significant.filter((e) => e.type === last.type);

  if (sameType.length > 1) {
    if (last.type === 'task.done') return `${sameType.length} tasks completed`;
    if (last.type === 'task.start') return `${sameType.length} tasks claimed`;
    if (last.type === 'task.block') return `${sameType.length} tasks blocked`;
    if (last.type === 'message') return `${sameType.length} new messages`;
    return `${sameType.length} ${last.type} events`;
  }

  const target = last.target ? ` ${last.target}` : '';
  const preview = last.preview ? ` — ${last.preview.slice(0, 40)}` : '';
  if (last.type === 'task.done') return `${last.agent} completed${target}`;
  if (last.type === 'task.start') return `${last.agent} claimed${target}`;
  if (last.type === 'task.block') return `${last.agent} blocked${target}${preview}`;
  if (last.type === 'message') return `${last.agent}${preview || ' sent a message'}`;
  return `${last.agent} ${last.type}${target}`;
}

export interface CompletionStateCache {
  tasks: Task[];
  allDone: boolean;
}

export function computeCompletionState(
  tasks: Task[],
  cached: CompletionStateCache | null
): CompletionStateCache {
  const allDone =
    cached && cached.tasks === tasks
      ? cached.allDone
      : tasks.length > 0 && tasks.every((t) => t.status === 'done');
  return { tasks, allDone };
}
