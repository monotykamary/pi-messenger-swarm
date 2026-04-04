/**
 * Pi Messenger - Activity Feed
 *
 * Append-only JSONL feed stored at <cwd>/.pi/messenger/feed/<channel>.jsonl
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeChannelId } from './channel.js';

export type FeedEventType =
  | 'join'
  | 'leave'
  | 'reserve'
  | 'release'
  | 'message'
  | 'commit'
  | 'test'
  | 'edit'
  | 'task.start'
  | 'task.done'
  | 'task.block'
  | 'task.unblock'
  | 'task.reset'
  | 'task.delete'
  | 'task.archive'
  | 'task.stop'
  | 'task.split'
  | 'task.revise'
  | 'task.revise-tree'
  | 'plan.start'
  | 'plan.pass.start'
  | 'plan.pass.done'
  | 'plan.review.start'
  | 'plan.review.done'
  | 'plan.done'
  | 'plan.cancel'
  | 'plan.failed'
  | 'stuck';

export interface FeedEvent {
  ts: string;
  agent: string;
  type: FeedEventType;
  target?: string;
  preview?: string;
  channel?: string;
}

interface FeedCacheEntry {
  mtimeMs: number;
  size: number;
  expiresAt: number;
  lines: string[];
  events: FeedEvent[];
}

const FEED_CACHE_TTL_MS = 100;
const feedCache = new Map<string, FeedCacheEntry>();

function feedDir(cwd: string): string {
  return path.join(cwd, '.pi', 'messenger', 'feed');
}

function feedPath(cwd: string, channelId: string): string {
  return path.join(feedDir(cwd), `${normalizeChannelId(channelId)}.jsonl`);
}

function invalidateFeedCache(cwd: string, channelId: string): void {
  feedCache.delete(feedPath(cwd, channelId));
}

function sanitizeInlineText(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\t', ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizePreview(value?: string): string | undefined {
  if (!value) return undefined;
  // Preserve newlines for multi-line previews, but normalize other whitespace
  const normalized = value.replaceAll('\r', '\n').replaceAll('\t', ' ').replace(/ +/g, ' ').trim();
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeAgentName(value: string): string {
  return sanitizeInlineText(value) ?? 'unknown';
}

export function sanitizeFeedEvent(event: FeedEvent): FeedEvent {
  return {
    ts: event.ts,
    type: event.type,
    agent: sanitizeAgentName(event.agent),
    target: sanitizeInlineText(event.target),
    preview: sanitizePreview(event.preview),
    channel: event.channel ? normalizeChannelId(event.channel) : undefined,
  };
}

function loadFeedCache(cwd: string, channelId: string): FeedCacheEntry | null {
  const p = feedPath(cwd, channelId);
  const now = Date.now();
  const cached = feedCache.get(p);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  if (!fs.existsSync(p)) {
    feedCache.delete(p);
    return null;
  }

  try {
    const stat = fs.statSync(p);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      cached.expiresAt = now + FEED_CACHE_TTL_MS;
      return cached;
    }

    const content = fs.readFileSync(p, 'utf-8').trim();
    if (!content) {
      const empty: FeedCacheEntry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        expiresAt: now + FEED_CACHE_TTL_MS,
        lines: [],
        events: [],
      };
      feedCache.set(p, empty);
      return empty;
    }

    const lines = content.split('\n');
    const events: FeedEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as FeedEvent;
        events.push(sanitizeFeedEvent(parsed));
      } catch {
        // Skip malformed lines
      }
    }

    const entry: FeedCacheEntry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      expiresAt: now + FEED_CACHE_TTL_MS,
      lines,
      events,
    };
    feedCache.set(p, entry);
    return entry;
  } catch {
    feedCache.delete(p);
    return null;
  }
}

export function appendFeedEvent(cwd: string, event: FeedEvent, channelId: string): void {
  const p = feedPath(cwd, channelId);
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const sanitized = sanitizeFeedEvent({ ...event, channel: normalizeChannelId(channelId) });
    fs.appendFileSync(p, JSON.stringify(sanitized) + '\n');
    invalidateFeedCache(cwd, channelId);
  } catch {
    // Best effort
  }
}

export function readFeedEvents(
  cwd: string,
  limit: number | undefined,
  channelId: string
): FeedEvent[] {
  const entry = loadFeedCache(cwd, channelId);
  if (!entry) return [];
  return limit ? entry.events.slice(-limit) : entry.events;
}

export function readFeedEventsWithOffset(
  cwd: string,
  offsetFromEnd: number,
  limit: number,
  channelId: string
): FeedEvent[] {
  const entry = loadFeedCache(cwd, channelId);
  if (!entry) return [];

  const totalLines = entry.lines.length;
  const endIndex = totalLines - offsetFromEnd;
  const startIndex = Math.max(0, endIndex - limit);

  if (startIndex >= endIndex || endIndex <= 0) return [];

  return entry.events.slice(startIndex, endIndex);
}

export function readFeedEventsByRange(
  cwd: string,
  startIndex: number,
  endIndex: number,
  channelId: string
): FeedEvent[] {
  const entry = loadFeedCache(cwd, channelId);
  if (!entry) return [];

  const totalLines = entry.lines.length;
  const clampedStart = Math.max(0, Math.min(startIndex, totalLines));
  const clampedEnd = Math.max(0, Math.min(endIndex, totalLines));

  if (clampedStart >= clampedEnd) return [];

  return entry.events.slice(clampedStart, clampedEnd);
}

export function getFeedLineCount(cwd: string, channelId: string): number {
  const entry = loadFeedCache(cwd, channelId);
  return entry?.lines.length ?? 0;
}

export function pruneFeed(cwd: string, maxEvents: number, channelId: string): void {
  const p = feedPath(cwd, channelId);
  if (!fs.existsSync(p)) return;

  try {
    const entry = loadFeedCache(cwd, channelId);
    if (!entry || entry.lines.length <= maxEvents) return;
    const pruned = entry.lines.slice(-maxEvents);
    fs.writeFileSync(p, pruned.join('\n') + '\n');
    invalidateFeedCache(cwd, channelId);
  } catch {
    // Best effort
  }
}

const SWARM_EVENT_TYPES = new Set<FeedEventType>([
  'task.start',
  'task.done',
  'task.block',
  'task.unblock',
  'task.reset',
  'task.delete',
  'task.archive',
  'task.split',
  'task.revise',
  'task.revise-tree',
  'plan.start',
  'plan.pass.start',
  'plan.pass.done',
  'plan.review.start',
  'plan.review.done',
  'plan.done',
  'plan.cancel',
  'plan.failed',
]);

export function formatFeedLine(event: FeedEvent): string {
  const sanitized = sanitizeFeedEvent(event);
  const time = new Date(sanitized.ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const isSwarm = SWARM_EVENT_TYPES.has(sanitized.type);
  const prefix = isSwarm ? '[Swarm] ' : '';
  let line = `${time} ${prefix}${sanitized.agent}`;

  const rawPreview = sanitized.preview;
  const normalizedPreview = rawPreview?.replace(/\n/g, ' ');
  const preview = normalizedPreview
    ? normalizedPreview.length > 90
      ? normalizedPreview.slice(0, 87) + '...'
      : normalizedPreview
    : '';
  const withPreview = (base: string) => (preview ? `${base} — ${preview}` : base);
  const target = sanitized.target ?? '';

  switch (sanitized.type) {
    case 'join':
      line += ' joined';
      break;
    case 'leave':
      line = withPreview(line + ' left');
      break;
    case 'reserve':
      line += ` reserved ${target}`;
      break;
    case 'release':
      line += ` released ${target}`;
      break;
    case 'message':
      if (target) {
        line += ` → ${target}`;
        if (preview) line += `: ${preview}`;
      } else {
        line += ' ✦';
        if (preview) line += ` ${preview}`;
      }
      break;
    case 'commit':
      line += preview ? ` committed "${preview}"` : ' committed';
      break;
    case 'test':
      line += preview ? ` ran tests (${preview})` : ' ran tests';
      break;
    case 'edit':
      line += ` editing ${target}`;
      break;
    case 'task.start':
      line += withPreview(` started ${target}`);
      break;
    case 'task.done':
      line += withPreview(` completed ${target}`);
      break;
    case 'task.block':
      line += withPreview(` blocked ${target}`);
      break;
    case 'task.unblock':
      line += withPreview(` unblocked ${target}`);
      break;
    case 'task.reset':
      line += withPreview(` reset ${target}`);
      break;
    case 'task.delete':
      line += withPreview(` deleted ${target}`);
      break;
    case 'task.archive':
      line += withPreview(` archived ${target || 'done tasks'}`);
      break;
    case 'task.split':
      line += withPreview(` split ${target}`);
      break;
    case 'task.revise':
      line += withPreview(` revised ${target}`);
      break;
    case 'task.revise-tree':
      line += withPreview(` revised ${target} + dependents`);
      break;
    case 'plan.start':
      line += withPreview(' planning started');
      break;
    case 'plan.pass.start':
      line += withPreview(' planning pass started');
      break;
    case 'plan.pass.done':
      line += withPreview(' planning pass finished');
      break;
    case 'plan.review.start':
      line += withPreview(' planning review started');
      break;
    case 'plan.review.done':
      line += withPreview(' planning review finished');
      break;
    case 'plan.done':
      line += withPreview(' planning completed');
      break;
    case 'plan.cancel':
      line += ' planning cancelled';
      break;
    case 'plan.failed':
      line += withPreview(' planning failed');
      break;
    case 'stuck':
      line += ' appears stuck';
      break;
    default:
      line += ` ${sanitized.type}`;
      break;
  }
  return line;
}

export function isSwarmEvent(type: FeedEventType): boolean {
  return SWARM_EVENT_TYPES.has(type);
}

export function logFeedEvent(
  cwd: string,
  agent: string,
  type: FeedEventType,
  target: string | undefined,
  preview: string | undefined,
  channelId: string
): void {
  appendFeedEvent(
    cwd,
    {
      ts: new Date().toISOString(),
      agent,
      type,
      target,
      preview,
      channel: channelId,
    },
    channelId
  );
}
