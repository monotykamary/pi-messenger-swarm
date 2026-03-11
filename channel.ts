import * as fs from "node:fs";
import * as path from "node:path";
import { generateMemorableName, type Dirs } from "./lib.js";

export type ChannelType = "session" | "named";

export interface ChannelRecord {
  id: string;
  type: ChannelType;
  createdAt: string;
  createdBy?: string;
  sessionId?: string;
  description?: string;
}

export const MEMORY_CHANNEL_ID = "memory";
export const HEARTBEAT_CHANNEL_ID = "heartbeat";
export const DEFAULT_NAMED_CHANNELS: ReadonlyArray<{ id: string; description: string }> = [
  { id: MEMORY_CHANNEL_ID, description: "Cross-session knowledge and insights" },
  { id: HEARTBEAT_CHANNEL_ID, description: "Long-term status, reports, and cron-style agent updates" },
];

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getChannelsDir(dirs: Dirs): string {
  return path.join(dirs.base, "channels");
}

export function normalizeChannelId(value: string | undefined | null): string {
  const trimmed = (value ?? "general").trim();
  const withoutHash = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return (withoutHash || "general").toLowerCase();
}

export function isValidChannelId(value: string): boolean {
  if (!value) return false;
  return /^[a-z0-9][a-z0-9._-]{0,79}$/.test(normalizeChannelId(value));
}

export function isSessionChannelId(value: string): boolean {
  return normalizeChannelId(value).startsWith("session-");
}

export function displayChannelLabel(channelId: string): string {
  const normalized = normalizeChannelId(channelId);
  return `#${normalized}`;
}

export function channelPath(dirs: Dirs, channelId: string): string {
  return path.join(getChannelsDir(dirs), `${normalizeChannelId(channelId)}.json`);
}

function normalizeChannelRecord(raw: Partial<ChannelRecord> | null | undefined, fallbackId?: string): ChannelRecord | null {
  const id = normalizeChannelId(raw?.id || fallbackId);
  if (!isValidChannelId(id)) return null;

  const type: ChannelType = raw?.type === "session" || raw?.type === "named"
    ? raw.type
    : (raw?.sessionId ? "session" : (isSessionChannelId(id) ? "session" : "named"));

  return {
    id,
    type,
    createdAt: raw?.createdAt || new Date(0).toISOString(),
    createdBy: raw?.createdBy,
    sessionId: raw?.sessionId,
    description: raw?.description,
  };
}

export function getChannel(dirs: Dirs, channelId: string): ChannelRecord | null {
  const filePath = channelPath(dirs, channelId);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<ChannelRecord>;
    return normalizeChannelRecord(parsed, path.basename(filePath, ".json"));
  } catch {
    return null;
  }
}

export function listChannels(dirs: Dirs): ChannelRecord[] {
  const dir = getChannelsDir(dirs);
  if (!fs.existsSync(dir)) return [];
  const items: ChannelRecord[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as Partial<ChannelRecord>;
      const normalized = normalizeChannelRecord(parsed, path.basename(file, ".json"));
      if (normalized) items.push(normalized);
    } catch {
      // Ignore malformed channel files
    }
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

export function writeChannel(dirs: Dirs, record: ChannelRecord): ChannelRecord {
  ensureDir(getChannelsDir(dirs));
  const filePath = channelPath(dirs, record.id);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, filePath);
  return record;
}

export function ensureNamedChannel(dirs: Dirs, channelId: string, createdBy?: string, description?: string): ChannelRecord {
  const normalized = normalizeChannelId(channelId);
  const existing = getChannel(dirs, normalized);
  if (existing) return existing;
  return writeChannel(dirs, {
    id: normalized,
    type: "named",
    createdAt: new Date().toISOString(),
    createdBy,
    description,
  });
}

export function ensureDefaultNamedChannels(dirs: Dirs, createdBy?: string): ChannelRecord[] {
  return DEFAULT_NAMED_CHANNELS.map(channel => ensureNamedChannel(dirs, channel.id, createdBy, channel.description));
}

function toKebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
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
    if (channel.type === "session" && channel.sessionId === sessionId) return channel;
  }
  return null;
}

export function createSessionChannel(dirs: Dirs, sessionId: string | undefined, createdBy?: string): ChannelRecord {
  return writeChannel(dirs, {
    id: allocateSessionChannelId(dirs, generateSessionChannelId()),
    type: "session",
    createdAt: new Date().toISOString(),
    createdBy,
    sessionId,
  });
}

export function ensureSessionChannel(dirs: Dirs, sessionId: string | undefined, createdBy?: string): ChannelRecord {
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

  if (DEFAULT_NAMED_CHANNELS.some(channel => channel.id === normalized)) {
    const preset = DEFAULT_NAMED_CHANNELS.find(channel => channel.id === normalized)!;
    return ensureNamedChannel(dirs, normalized, options?.createdBy, preset.description);
  }

  if (!options?.create) return null;

  if (isSessionChannelId(normalized)) {
    return writeChannel(dirs, {
      id: normalized,
      type: "session",
      createdAt: new Date().toISOString(),
      createdBy: options.createdBy,
      description: options.description,
    });
  }

  return ensureNamedChannel(dirs, normalized, options.createdBy, options.description);
}
