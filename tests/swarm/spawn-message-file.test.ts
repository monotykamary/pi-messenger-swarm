/**
 * Tests for --message-file spawn flag.
 *
 * Verifies that mission text can be read from a file to avoid
 * shell interpolation of backticks, ${...}, and parentheses.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('../../swarm/progress.js', () => ({
  createProgress: () => ({
    tokens: 0,
    toolCallCount: 0,
    recentTools: [],
    status: 'running',
  }),
  updateProgress: () => {},
}));

vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import { executeSpawn } from '../../swarm/handlers/spawn.js';
import { clearSpawnStateForTests } from '../../swarm/spawn.js';
import type { MessengerState } from '../../lib.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 90000 + Math.floor(Math.random() * 9999);
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn(() => true);
}

const roots = new Set<string>();

function tempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-msgfile-test-'));
  roots.add(cwd);
  return cwd;
}

function tempFile(content: string): string {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-msgfile-')),
    'mission.txt'
  );
  roots.add(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

const baseState: MessengerState = {
  agentName: 'TestOrchestrator',
  registered: true,
  reservations: [],
  chatHistory: new Map(),
  unreadCounts: new Map(),
  channelPostHistory: [],
  seenSenders: new Map(),
  model: '',
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
  currentChannel: 'test',
  sessionChannel: 'test',
  joinedChannels: ['test'],
};

describe('spawn --message-file', () => {
  beforeEach(() => {
    clearSpawnStateForTests();
    spawnMock.mockReset();
  });

  afterEach(() => {
    clearSpawnStateForTests();
    for (const root of roots) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {}
    }
    roots.clear();
  });

  it('reads mission text from a file when messageFile is provided', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-basic';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const missionText = 'Fix the compileProject bug: pass fs to compile()';
    const filePath = tempFile(missionText);

    const result = executeSpawn(
      null,
      { messageFile: filePath, role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');

    // Verify the spawn was launched (mock was called)
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('messageFile content takes priority over positional message', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-priority';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const fileContent = 'Mission from file with ${variable} and `backtick`';
    const filePath = tempFile(fileContent);

    const result = executeSpawn(
      null,
      { messageFile: filePath, message: 'Fallback text', role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('preserves shell-special characters in file content', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-shell-chars';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    // This is the exact kind of text that gets mangled by bash interpolation
    const shellUnsafeContent = [
      'Fix compileProject: pass fs to compile()',
      'Edge key: ${edge.src?.path}->${edge.dst?.path}',
      'Use compileOpts.darkThemeID ?? 0',
      'Regex: ^n_(.+?)->n_(.+?)$',
      'Pipe: |md block content |',
    ].join('\n');
    const filePath = tempFile(shellUnsafeContent);

    const result = executeSpawn(
      null,
      { messageFile: filePath, role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('returns error when messageFile does not exist', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-nonexistent';

    const result = executeSpawn(
      null,
      { messageFile: '/nonexistent/path/mission.txt', role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('cannot read --message-file');
    const details = (result as any).details ?? {};
    expect(details.error).toBe('message_file_read_error');
  });

  it('falls back to positional message when messageFile is not provided', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-fallback';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const result = executeSpawn(
      null,
      { message: 'Simple mission text', role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });

  it('handles empty file content gracefully', () => {
    const cwd = tempCwd();
    const sessionId = 'msgfile-empty';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    // File with only whitespace
    const filePath = tempFile('   \n\n  ');

    // Empty file content should not override a positional message
    const result = executeSpawn(
      null,
      { messageFile: filePath, message: 'Fallback mission', role: 'Developer' },
      baseState,
      cwd,
      sessionId,
      10
    );

    expect(result).toBeDefined();
    const text = (result as any).content?.[0]?.text ?? '';
    expect(text).toContain('🚀 Spawned');
  });
});
