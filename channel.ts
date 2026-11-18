import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateMemorableName, type Dirs } from './lib.js';
import { atomicWriteFileSync, isMissing, readTextIfPresent, withFileLock } from './persistence.js';

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

/** Threshold in ms after which a channel without activity is considered stale. */
export const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
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

/**
 * Read the metadata header from a channel JSONL file.
 * Returns null if file doesn't exist or has invalid header.
 */
export function readChannelHeader(dirs: Dirs, channelId: string): ChannelMetaHeader | null {
  try {
    return readChannelHead(channelPath(dirs, channelId))?.header ?? null;
  } catch {
    return null;
  }
}

/**
 * Read all event lines from a channel JSONL file (skips the metadata header).
 * Returns raw JSON strings, not parsed objects.
 */
/** Get the timestamp of the last feed event in a channel, or null if no events. */
export function getLastActivity(dirs: Dirs, channelId: string): string | null {
  try {
    const events = readChannelEventLines(dirs, channelId);
    if (events.length === 0) return null;
    const last = JSON.parse(events[events.length - 1]) as { ts?: string } | null;
    return last?.ts ?? null;
  } catch {
    return null;
  }
}

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

class MalformedChannelError extends Error {}

function parseHeader(line: string, filePath: string): ChannelMetaHeader {
  let header: unknown;
  try {
    header = JSON.parse(line);
  } catch {
    throw new MalformedChannelError(`Malformed channel header: ${filePath}`);
  }
  if (!isMetaHeader(header))
    throw new MalformedChannelError(`Malformed channel header: ${filePath}`);
  return header;
}

// Append and channel discovery should not scan the whole history. Read
// just the header and, for append, whether the last record ends with a LF.
function readChannelHead(filePath: string, checkTail = false) {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    for (;;) {
      const buffer = Buffer.allocUnsafe(4096);
      const count = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      const chunk = buffer.subarray(0, count);
      const newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      if (newline !== -1) break;
      position += count;
    }
    const header = parseHeader(Buffer.concat(chunks).toString('utf-8'), filePath);
    let needsSeparator = false;
    if (checkTail) {
      const last = Buffer.allocUnsafe(1);
      const size = fs.fstatSync(fd).size;
      needsSeparator = fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 10;
    }
    return { header, needsSeparator };
  } finally {
    fs.closeSync(fd);
  }
}

function readChannelSnapshot(filePath: string) {
  const content = readTextIfPresent(filePath);
  if (content === undefined) return undefined;
  const [headerLine, ...lines] = content.split('\n');
  return {
    header: parseHeader(headerLine, filePath),
    headerLine,
    lines,
  };
}

function checkedEventLines(lines: string[]): string[] {
  const events = lines.filter((line) => line.trim());
  for (const line of events) JSON.parse(line);
  return events;
}

// Catalog operations (e.g. session lookup + allocation) and all channel
// mutations share this lock. Readers of snapshots don't need a lock.
function withChannelsLock<T>(dirs: Dirs, operation: () => T): T {
  const dir = getChannelsDir(dirs);
  ensureDir(dir);
  return withFileLock(path.join(dir, '.channels'), operation);
}

/** Append one JSONL event, publishing the initial header and event together. */
export function appendChannelEventLine(
  dirs: Dirs,
  channelId: string,
  eventLine: string,
  meta?: Partial<ChannelRecord>
): void {
  const filePath = channelPath(dirs, channelId);
  try {
    // Never introduce a partial or multi-line record through the append API.
    if (eventLine.includes('\n')) return;
    JSON.parse(eventLine);
    withChannelsLock(dirs, () => {
      const current = readChannelHead(filePath, true);
      if (!current) {
        const header = createMetaHeader({
          id: normalizeChannelId(channelId),
          type: isSessionChannelId(channelId) ? 'session' : 'named',
          createdAt: new Date().toISOString(),
          createdBy: meta?.createdBy,
          sessionId: meta?.sessionId,
          description: meta?.description,
        });
        atomicWriteFileSync(filePath, `${JSON.stringify(header)}\n${eventLine}\n`);
      } else {
        const separator = current.needsSeparator ? '\n' : '';
        fs.appendFileSync(filePath, `${separator}${eventLine}\n`);
      }
    });
  } catch {
    // Best effort
  }
}

/** Keep the last N events, without exposing a truncated file to readers. */
export function pruneChannelEvents(dirs: Dirs, channelId: string, maxEvents: number): void {
  if (!Number.isFinite(maxEvents) || maxEvents < 0) return;
  try {
    withChannelsLock(dirs, () => {
      const filePath = channelPath(dirs, channelId);
      const current = readChannelSnapshot(filePath);
      if (!current) return;
      const events = checkedEventLines(current.lines);
      const keep = Math.floor(maxEvents);
      if (events.length <= keep) return;
      const pruned = keep === 0 ? [] : events.slice(-keep);
      atomicWriteFileSync(filePath, [current.headerLine, ...pruned].join('\n') + '\n');
    });
  } catch {
    // Best effort; do not replace a corrupt snapshot.
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
      const head = readChannelHead(filePath);
      if (head) items.push(metaHeaderToRecord(head.header));
    } catch {
      // Ignore malformed channel files
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

function writeChannelUnlocked(dirs: Dirs, record: ChannelRecord): ChannelRecord {
  const filePath = channelPath(dirs, record.id);
  const current = readChannelSnapshot(filePath);
  const events = current ? checkedEventLines(current.lines) : [];
  const lines = [JSON.stringify(createMetaHeader(record)), ...events];
  atomicWriteFileSync(filePath, lines.join('\n') + '\n');
  return record;
}

export function writeChannel(dirs: Dirs, record: ChannelRecord): ChannelRecord {
  return withChannelsLock(dirs, () => writeChannelUnlocked(dirs, record));
}

/** Fill in the session ID once; the predicate and update use the same snapshot. */
export function patchChannelSessionId(dirs: Dirs, channelId: string, sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    return withChannelsLock(dirs, () => {
      const filePath = channelPath(dirs, channelId);
      const current = readChannelSnapshot(filePath);
      if (!current || current.header.sessionId) return false;
      checkedEventLines(current.lines);
      current.header.sessionId = sessionId;
      atomicWriteFileSync(filePath, [JSON.stringify(current.header), ...current.lines].join('\n'));
      return true;
    });
  } catch {
    return false;
  }
}

function ensureChannelUnlocked(dirs: Dirs, record: ChannelRecord): ChannelRecord {
  let current;
  try {
    current = readChannelHead(channelPath(dirs, record.id));
  } catch (error) {
    // Legacy #memory was implicitly joinable; keep its routing without
    // discarding a legacy/corrupt file that needs manual repair.
    if (record.id === MEMORY_CHANNEL_ID && error instanceof MalformedChannelError) return record;
    throw error;
  }
  return current ? metaHeaderToRecord(current.header) : writeChannelUnlocked(dirs, record);
}

export function ensureNamedChannel(
  dirs: Dirs,
  channelId: string,
  createdBy?: string,
  description?: string
): ChannelRecord {
  return withChannelsLock(dirs, () =>
    ensureChannelUnlocked(dirs, {
      id: normalizeChannelId(channelId),
      type: 'named',
      createdAt: new Date().toISOString(),
      createdBy,
      description,
    })
  );
}

export function ensureDefaultNamedChannels(dirs: Dirs, createdBy?: string): ChannelRecord[] {
  return DEFAULT_NAMED_CHANNELS.map((channel) =>
    ensureNamedChannel(dirs, channel.id, createdBy, channel.description)
  );
}

export function agentNameToChannelId(name: string): string {
  const result = toKebabCase(name);
  return isValidChannelId(result) ? result : '';
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
  const available = (id: string) => {
    try {
      // A malformed file or dangling symlink also occupies its name.
      fs.lstatSync(channelPath(dirs, id));
      return false;
    } catch (error) {
      if (isMissing(error)) return true;
      throw error;
    }
  };
  if (available(normalizedBase)) return normalizedBase;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${normalizedBase}-${i}`;
    if (available(candidate)) return candidate;
  }
  throw new Error(`No free channel ID for ${normalizedBase}`);
}

export function generateSessionChannelId(agentName?: string): string {
  const generated = agentName ?? generateMemorableName();
  return toKebabCase(generated);
}

export function findChannelBySessionId(dirs: Dirs, sessionId: string): ChannelRecord | null {
  if (!sessionId) return null;
  for (const channel of listChannels(dirs)) {
    if (channel.type === 'session' && channel.sessionId === sessionId) return channel;
  }
  return null;
}

function createSessionChannelUnlocked(
  dirs: Dirs,
  sessionId: string | undefined,
  createdBy?: string
): ChannelRecord {
  return writeChannelUnlocked(dirs, {
    id: allocateSessionChannelId(dirs, generateSessionChannelId(createdBy)),
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
  return withChannelsLock(dirs, () => {
    const existing = sessionId ? findChannelBySessionId(dirs, sessionId) : null;
    return existing ?? createSessionChannelUnlocked(dirs, sessionId, createdBy);
  });
}

export function ensureExistingOrCreateChannel(
  dirs: Dirs,
  channelId: string,
  options?: { create?: boolean; createdBy?: string; description?: string }
): ChannelRecord | null {
  const normalized = normalizeChannelId(channelId);
  if (!isValidChannelId(normalized)) return null;

  const preset = DEFAULT_NAMED_CHANNELS.find((channel) => channel.id === normalized);
  if (!preset && !options?.create) return getChannel(dirs, normalized);

  return withChannelsLock(dirs, () =>
    ensureChannelUnlocked(dirs, {
      id: normalized,
      type: isSessionChannelId(normalized) ? 'session' : 'named',
      createdAt: new Date().toISOString(),
      createdBy: options?.createdBy,
      description: preset?.description ?? options?.description,
    })
  );
}
