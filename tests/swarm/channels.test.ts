/**
 * Tests for `pi-messenger-swarm channels`
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dirs, MessengerState } from '../../lib.js';
import { executeChannels } from '../../handlers.js';
import { CHANNEL_META_VERSION } from '../../channel.js';
import { listChannels } from '../../channel.js';

const roots = new Set<string>();

function createDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  fs.mkdirSync(registry, { recursive: true });
  return { base, registry };
}

function createState(overrides: Partial<MessengerState> = {}): MessengerState {
  return {
    agentName: 'TestAgent',
    registered: true,
    watcher: null,
    watcherRetries: 0,
    watcherRetryTimer: null,
    watcherDebounceTimer: null,
    reservations: [],
    chatHistory: new Map(),
    unreadCounts: new Map(),
    channelPostHistory: [],
    seenSenders: new Map(),
    model: 'test-model',
    gitBranch: undefined,
    spec: undefined,
    scopeToFolder: false,
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    statusMessage: undefined,
    customStatus: false,
    registryFlushTimer: null,
    sessionStartedAt: new Date().toISOString(),
    contextSessionId: 'test-session',
    currentChannel: 'test-channel',
    sessionChannel: 'test-channel',
    joinedChannels: ['test-channel', 'memory'],
    ...overrides,
  } as MessengerState;
}

/** Create a bare channel JSONL file with metadata header */
function createChannelFile(dirs: Dirs, id: string, type: 'session' | 'named', ts?: string) {
  const channelsDir = path.join(dirs.base, 'channels');
  fs.mkdirSync(channelsDir, { recursive: true });
  const filePath = path.join(channelsDir, `${id}.jsonl`);
  const header = JSON.stringify({
    _meta: true,
    v: CHANNEL_META_VERSION,
    id,
    type,
    createdAt: ts || new Date().toISOString(),
  });
  fs.writeFileSync(filePath, header + '\n');
}

/** Append a feed event line to a channel file (to simulate activity) */
function appendFeedEvent(dirs: Dirs, channelId: string, ts: string) {
  const channelsDir = path.join(dirs.base, 'channels');
  const filePath = path.join(channelsDir, `${channelId}.jsonl`);
  const event = JSON.stringify({ ts, type: 'join', agent: 'someone' });
  fs.appendFileSync(filePath, event + '\n');
}

/** Write a registration file for a live agent */
function writeAgentRegistration(dirs: Dirs, name: string, channel: string) {
  const reg = {
    name,
    pid: process.pid,
    sessionId: 'test-session',
    cwd: process.cwd(),
    model: 'test-model',
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
    currentChannel: channel,
    sessionChannel: channel,
    joinedChannels: [channel, 'memory'],
  };
  fs.writeFileSync(path.join(dirs.registry, `${name}.json`), JSON.stringify(reg, null, 2));
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  roots.clear();
});

describe('swarm channels', () => {
  it('shows active named channels and #memory as always active', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    // Named channels (memory is persistent, dev is recently created)
    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'dev', 'named');

    const result = executeChannels(state, dirs, cwd);
    expect(result.content[0]?.text).toContain('#memory');
    expect(result.content[0]?.text).toContain('persistent');
    expect(result.content[0]?.text).toContain('#dev');
    expect(result.content[0]?.text).toContain('named');
    expect(result.details.active).toBe(2);
  });

  it('hides stale named channels by default (except #memory)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'dev', 'named');

    // Make dev stale: last activity > 30 min ago
    appendFeedEvent(dirs, 'dev', new Date(Date.now() - 45 * 60_000).toISOString());

    const result = executeChannels(state, dirs, cwd);
    // #memory is always active
    expect(result.content[0]?.text).toContain('#memory');
    // #dev is stale → hidden from default view
    expect(result.content[0]?.text).not.toContain('#dev');
    expect(result.details.active).toBe(1);
    expect(result.details.inactive).toBe(1);
  });

  it('shows stale named channels with --all', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'dev', 'named');

    // Make dev stale
    appendFeedEvent(dirs, 'dev', new Date(Date.now() - 45 * 60_000).toISOString());

    const result = executeChannels(state, dirs, cwd, true);
    expect(result.content[0]?.text).toContain('#memory');
    expect(result.content[0]?.text).toContain('#dev');
    expect(result.content[0]?.text).toContain('last activity');
  });

  it('shows session channels with live agents as active', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'session-blue-fox', 'session');
    createChannelFile(dirs, 'session-rapid-otter', 'session');

    // Agent in session-blue-fox, none in session-rapid-otter
    writeAgentRegistration(dirs, 'WorkerBot', 'session-blue-fox');

    const result = executeChannels(state, dirs, cwd);
    expect(result.content[0]?.text).toContain('#session-blue-fox');
    expect(result.content[0]?.text).toContain('1 agent');
    expect(result.content[0]?.text).toContain('WorkerBot');
    // session-rapid-otter has no agent and no feed events → hidden
    expect(result.content[0]?.text).not.toContain('#session-rapid-otter');
    expect(result.details.inactive).toBe(1);
  });

  it('shows session channels with recent feed activity as idle', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'session-recent', 'session');
    createChannelFile(dirs, 'session-old', 'session');

    // Recent activity (within 30min threshold)
    appendFeedEvent(dirs, 'session-recent', new Date(Date.now() - 60_000).toISOString());
    // Old activity (beyond 30min threshold)
    appendFeedEvent(dirs, 'session-old', new Date(Date.now() - 45 * 60_000).toISOString());

    const result = executeChannels(state, dirs, cwd);
    expect(result.content[0]?.text).toContain('#session-recent');
    expect(result.content[0]?.text).toContain('idle');
    expect(result.content[0]?.text).toContain('1m ago');
    // session-old is beyond threshold → hidden
    expect(result.content[0]?.text).not.toContain('#session-old');
  });

  it('shows all channels including stale with --all flag', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    createChannelFile(dirs, 'memory', 'named');
    createChannelFile(dirs, 'session-active', 'session');
    createChannelFile(dirs, 'session-stale', 'session');

    writeAgentRegistration(dirs, 'ActiveBot', 'session-active');

    const result = executeChannels(state, dirs, cwd, true);
    expect(result.content[0]?.text).toContain('#memory');
    expect(result.content[0]?.text).toContain('#session-active');
    expect(result.content[0]?.text).toContain('#session-stale');
    expect(result.details.total).toBe(3);
  });

  it('returns not_registered error when not registered', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState({ registered: false });

    const result = executeChannels(state, dirs, cwd);
    expect(result.content[0]?.text).toContain('Not registered');
  });

  it('returns empty when no channels exist', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-channels-test-'));
    roots.add(cwd);
    const dirs = createDirs(cwd);
    const state = createState();

    const result = executeChannels(state, dirs, cwd);
    expect(result.content[0]?.text).toContain('No channels found');
  });
});
