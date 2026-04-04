import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';

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
  parseJsonlLine: () => null,
  updateProgress: () => {},
}));

vi.mock('../../swarm/live-progress.js', () => ({
  removeLiveWorker: () => {},
  updateLiveWorker: () => {},
}));

import { spawnSubagent, clearSpawnStateForTests } from '../../swarm/spawn.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-swarm-file-'));
  roots.add(cwd);
  return cwd;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
  spawnMock.mockClear();
});

describe('swarm spawn with agentFile', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('uses file content as system prompt', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-agent-file';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    // Create a simple agent file anywhere (not in special directory)
    const agentFile = path.join(cwd, 'my-agent.md');
    fs.writeFileSync(agentFile, 'You are a security expert. Be thorough.', 'utf-8');

    spawnSubagent(
      cwd,
      {
        agentFile: './my-agent.md',
        message: 'Review the auth code',
      },
      sessionId
    );

    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);

    const promptPath = args[idx + 1];
    const content = fs.readFileSync(promptPath, 'utf-8');

    // File content is used directly as system prompt
    expect(content).toBe('You are a security expert. Be thorough.');

    proc.emit('close', 0);
  });

  it('uses message directly as user prompt', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-user-prompt';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agentFile = path.join(cwd, 'agent.md');
    fs.writeFileSync(agentFile, 'System prompt here', 'utf-8');

    spawnSubagent(
      cwd,
      {
        agentFile: './agent.md',
        message: 'Do this specific task',
      },
      sessionId
    );

    const args = spawnMock.mock.calls[0][1] as string[];
    // User prompt is the last argument
    const userPrompt = args[args.length - 1];
    expect(userPrompt).toBe('Do this specific task');

    proc.emit('close', 0);
  });

  it('throws when file not found', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-not-found';

    expect(() =>
      spawnSubagent(
        cwd,
        {
          agentFile: './nonexistent.md',
          message: 'Do something',
        },
        sessionId
      )
    ).toThrow();
  });

  it('accepts absolute path', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-absolute';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agentFile = path.join(cwd, 'custom', 'path', 'agent.md');
    fs.mkdirSync(path.dirname(agentFile), { recursive: true });
    fs.writeFileSync(agentFile, 'Custom agent content', 'utf-8');

    spawnSubagent(
      cwd,
      {
        agentFile: agentFile, // Absolute path
        message: 'Do work',
      },
      sessionId
    );

    const args = spawnMock.mock.calls[0][1] as string[];
    const idx = args.indexOf('--append-system-prompt');
    const promptPath = args[idx + 1];
    const content = fs.readFileSync(promptPath, 'utf-8');

    expect(content).toBe('Custom agent content');

    proc.emit('close', 0);
  });

  it('generates agent file immediately on spawn', () => {
    const cwd = createTempCwd();
    const sessionId = 'test-session-generate-on-spawn';
    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    const agent = spawnSubagent(
      cwd,
      {
        role: 'Researcher',
        persona: 'Curious and thorough',
        objective: 'Investigate the codebase',
        message: 'Find all TODO comments',
      },
      sessionId
    );

    // Agent file should exist immediately (before process exits)
    const agentFilePath = path.join(
      cwd,
      '.pi',
      'messenger',
      'agents',
      sessionId,
      `${agent.name}-${agent.id}.md`
    );
    expect(fs.existsSync(agentFilePath)).toBe(true);

    // File should contain initial state with status: running
    const content = fs.readFileSync(agentFilePath, 'utf-8');
    expect(content).toContain('status: running');
    expect(content).toContain('role: Researcher');
    expect(content).toContain('persona: Curious and thorough');
    expect(content).toContain('Investigate the codebase');

    // File should NOT contain ended or exitCode yet (agent still running)
    expect(content).not.toContain('ended:');
    expect(content).not.toContain('exitCode:');

    // Now close the process and verify file is updated
    proc.emit('close', 0);

    const finalContent = fs.readFileSync(agentFilePath, 'utf-8');
    expect(finalContent).toContain('status: completed');
    expect(finalContent).toContain('ended:');
    expect(finalContent).toContain('exitCode: 0');
  });
});
