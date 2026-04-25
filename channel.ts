import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateMemorableName, type Dirs } from './lib.js';

export type ChannelType = 'session' | 'named';

export interface ChannelRecord {
  id: string;
  type: ChannelType;
  createdAt: string;
  createdBy?: string;
  sessionId?: string;
  description?: string;
}

/** Channel metadata header stored as the first line of the JSONL file */
export interface ChannelMetaHeader {
  _meta: true;
  v: number;
  id: string;
  type: ChannelType;
  createdAt: string;
  createdBy?: string;
  sessionId?: string;
  description?: string;
}

export const CHANNEL_META_VERSION = 1;

export const MEMORY_CHANNEL_ID = 'memory';
export const DEFAULT_NAMED_CHANNELS: ReadonlyArray<{ id: string; description: string }> = [
  { id: MEMORY_CHANNEL_ID, description: 'Cross-session knowledge and insights' },
];

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getChannelsDir(dirs: Dirs): string {
  return path.join(dirs.base, 'channels');
}

export function normalizeChannelId(value: string): string {
  const trimmed = value.trim();
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  return (withoutHash || value).toLowerCase();
}

export function isValidChannelId(value: string | undefined | null): boolean {
  if (!value) return false;
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalizeChannelId(value));
}

export function isSessionChannelId(value: string): boolean {
  return normalizeChannelId(value).startsWith('session-');
}

export function displayChannelLabel(channelId: string): string {
  const normalized = normalizeChannelId(channelId);
  return `#${normalized}`;
}

/** Returns the path to the unified channel JSONL file (metadata + feed) */
export function channelPath(dirs: Dirs, channelId: string): string {
  return path.join(getChannelsDir(dirs), `${normalizeChannelId(channelId)}.jsonl`);
}

function createMetaHeader(record: ChannelRecord): ChannelMetaHeader {
  return {
    _meta: true,
    v: CHANNEL_META_VERSION,
    id: record.id,
    type: record.type,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    sessionId: record.sessionId,
    description: record.description,
  };
}

export function isMetaHeader(obj: unknown): obj is ChannelMetaHeader {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return o._meta === true && typeof o.v === 'number' && typeof o.id === 'string';
}

function metaHeaderToRecord(header: ChannelMetaHeader): ChannelRecord {
  return {
    id: header.id,
    type: header.type,
    createdAt: header.createdAt,
    createdBy: header.createdBy,
    sessionId: header.sessionId,
    description: header.description,
  };
}

function normalizeChannelRecord(
  raw: Partial<ChannelRecord> | null | undefined,
  fallbackId?: string
): ChannelRecord | null {
  const id = normalizeChannelId(raw?.id || fallbackId);
  if (!isValidChannelId(id)) return null;

  const type: ChannelType =
    raw?.type === 'session' || raw?.type === 'named'
      ? raw.type
      : raw?.sessionId
        ? 'session'
        : isSessionChannelId(id)
          ? 'session'
          : 'named';

  return {
    id,
    type,
    createdAt: raw?.createdAt || new Date(0).toISOString(),
    createdBy: raw?.createdBy,
    sessionId: raw?.sessionId,
    description: raw?.description,
  };
}

/**
 * Read the metadata header from a channel JSONL file.
 * Returns null if file doesn't exist or has invalid header.
 */
export function readChannelHeader(dirs: Dirs, channelId: string): ChannelMetaHeader | null {
  const filePath = channelPath(dirs, channelId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const firstLine = content.split('\n')[0];
    if (!firstLine) return null;
    const parsed = JSON.parse(firstLine) as unknown;
    if (isMetaHeader(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore parse errors
  }
  return null;
}

/**
 * Read all event lines from a channel JSONL file (skips the metadata header).
 * Returns raw JSON strings, not parsed objects.
 */
export function readChannelEventLines(dirs: Dirs, channelId: string): string[] {
  const filePath = channelPath(dirs, channelId);
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    const lines = content.split('\n');
    // Skip first line (metadata header)
    return lines.slice(1).filter((line) => line.trim());
  } catch {
    return [];
  }
}

/**
 * Append a single event line to a channel JSONL file.
 * Creates the file with metadata header if it doesn't exist.
 */
export function appendChannelEventLine(
  dirs: Dirs,
  channelId: string,
  eventLine: string,
  meta?: Partial<ChannelRecord>
): void {
  const filePath = channelPath(dirs, channelId);
  try {
    ensureDir(getChannelsDir(dirs));

    if (!fs.existsSync(filePath)) {
      // Create new file with minimal metadata header
      const header: ChannelMetaHeader = {
        _meta: true,
        v: CHANNEL_META_VERSION,
        id: normalizeChannelId(channelId),
        type: isSessionChannelId(channelId) ? 'session' : 'named',
        createdAt: new Date().toISOString(),
        createdBy: meta?.createdBy,
        sessionId: meta?.sessionId,
        description: meta?.description,
      };
      fs.writeFileSync(filePath, JSON.stringify(header) + '\n' + eventLine + '\n');
    } else {
      fs.appendFileSync(filePath, eventLine + '\n');
    }
  } catch {
    // Best effort
  }
}

/**
 * Prune events in a channel JSONL file to keep only the last N events.
 * Preserves the metadata header.
 */
export function pruneChannelEvents(dirs: Dirs, channelId: string, maxEvents: number): void {
  const filePath = channelPath(dirs, channelId);
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length <= 1) return; // Only header or empty

    const header = lines[0];
    const events = lines.slice(1).filter((line) => line.trim());
    if (events.length <= maxEvents) return;

    const pruned = events.slice(-maxEvents);
    fs.writeFileSync(filePath, header + '\n' + pruned.join('\n') + '\n');
  } catch {
    // Best effort
  }
}

export function getChannel(dirs: Dirs, channelId: string): ChannelRecord | null {
  const header = readChannelHeader(dirs, channelId);
  if (header) {
    return metaHeaderToRecord(header);
  }
  return null;
}

export function listChannels(dirs: Dirs): ChannelRecord[] {
  const dir = getChannelsDir(dirs);
  if (!fs.existsSync(dir)) return [];
  const items: ChannelRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const filePath = path.join(dir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const firstLine = content.split('\n')[0];
      if (!firstLine) continue;
      const parsed = JSON.parse(firstLine) as unknown;
      if (isMetaHeader(parsed)) {
        items.push(metaHeaderToRecord(parsed));
      }
    } catch {
      // Ignore malformed channel files
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeChannel(dirs: Dirs, record: ChannelRecord): ChannelRecord {
  ensureDir(getChannelsDir(dirs));
  const filePath = channelPath(dirs, record.id);
  const metaHeader = createMetaHeader(record);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  // Write metadata header as first line, preserving any existing events
  let existingEvents: string[] = [];
  if (fs.existsSync(filePath)) {
    try {
      existingEvents = readChannelEventLines(dirs, record.id);
    } catch {
      // Ignore read errors, start fresh
    }
  }
  const lines = [JSON.stringify(metaHeader), ...existingEvents];
  fs.writeFileSync(tmp, lines.join('\n') + '\n');
  fs.renameSync(tmp, filePath);
  return record;
}

/**
 * Patch the sessionId on a channel's metadata header if it's currently empty.
 * Used by the harness server when it discovers the session ID after the channel
 * was already created (race condition with session-id file).
 * Returns true if the channel was patched, false if no change was needed.
 */
export function patchChannelSessionId(dirs: Dirs, channelId: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const header = readChannelHeader(dirs, channelId);
  if (!header || header.sessionId) return false; // already set or missing

  const filePath = channelPath(dirs, channelId);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length === 0) return false;

    const meta = JSON.parse(lines[0]) as ChannelMetaHeader;
    meta.sessionId = sessionId;
    lines[0] = JSON.stringify(meta);

    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, filePath);
    return true;
  } catch {
    return false;
  }
}

export function ensureNamedChannel(
  dirs: Dirs,
  channelId: string,
  createdBy?: string,
  description?: string
): ChannelRecord {
  const normalized = normalizeChannelId(channelId);
  const existing = getChannel(dirs, normalized);
  if (existing) return existing;
  return writeChannel(dirs, {
    id: normalized,
    type: 'named',
    createdAt: new Date().toISOString(),
    createdBy,
    description,
  });
}

export function ensureDefaultNamedChannels(dirs: Dirs, createdBy?: string): ChannelRecord[] {
  return DEFAULT_NAMED_CHANNELS.map((channel) =>
    ensureNamedChannel(dirs, channel.id, createdBy, channel.description)
  );
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

function allocateSessionChannelId(dirs: Dirs, baseId: string): string {
  const normalizedBase = normalizeChannelId(baseId);
  if (!getChannel(dirs, normalizedBase)) return normalizedBase;

  for (let i = 2; i <= 99; i++) {
    const candidate = `${normalizedBase}-${i}`;
    if (!getChannel(dirs, candidate)) return candidate;
  }

  const suffix = Math.random().toString(36).slice(2, 6);
  return `${normalizedBase}-${suffix}`;
}

export function generateSessionChannelId(): string {
  const generated = generateMemorableName();
  return toKebabCase(generated);
}

export function findChannelBySessionId(dirs: Dirs, sessionId: string): ChannelRecord | null {
  if (!sessionId) return null;
  for (const channel of listChannels(dirs)) {
    if (channel.type === 'session' && channel.sessionId === sessionId) return channel;
  }
  return null;
}

export function createSessionChannel(
  dirs: Dirs,
  sessionId: string | undefined,
  createdBy?: string
): ChannelRecord {
  return writeChannel(dirs, {
    id: allocateSessionChannelId(dirs, generateSessionChannelId()),
    type: 'session',
    createdAt: new Date().toISOString(),
    createdBy,
    sessionId,
  });
}

export function ensureSessionChannel(
  dirs: Dirs,
  sessionId: string | undefined,
  createdBy?: string
): ChannelRecord {
  if (sessionId) {
    const existing = findChannelBySessionId(dirs, sessionId);
    if (existing) return existing;
  }
  return createSessionChannel(dirs, sessionId, createdBy);
}

export function ensureExistingOrCreateChannel(
  dirs: Dirs,
  channelId: string,
  options?: { create?: boolean; createdBy?: string; description?: string }
): ChannelRecord | null {
  const normalized = normalizeChannelId(channelId);
  if (!isValidChannelId(normalized)) return null;

  const existing = getChannel(dirs, normalized);
  if (existing) return existing;

  if (DEFAULT_NAMED_CHANNELS.some((channel) => channel.id === normalized)) {
    const preset = DEFAULT_NAMED_CHANNELS.find((channel) => channel.id === normalized)!;
    return ensureNamedChannel(dirs, normalized, options?.createdBy, preset.description);
  }

  if (!options?.create) return null;

  if (isSessionChannelId(normalized)) {
    return writeChannel(dirs, {
      id: normalized,
      type: 'session',
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy,
      description: options.description,
    });
  }

  return ensureNamedChannel(dirs, normalized, options.createdBy, options.description);
}
