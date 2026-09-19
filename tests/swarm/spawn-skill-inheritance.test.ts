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

import { spawnSubagent, clearSpawnStateForTests } from '../../swarm/spawn.js';

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  kill = vi.fn();
}

const roots = new Set<string>();
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-skills-test-'));
  roots.add(cwd);
  return cwd;
}

function createSkillDir(parent: string, name: string): string {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Test skill ${name}\n---\n# ${name}\n`
  );
  return dir;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
  clearSpawnStateForTests();
  if (originalAgentDir !== undefined) {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  } else {
    delete process.env.PI_CODING_AGENT_DIR;
  }
});

describe('swarm spawn skill inheritance', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('passes --skill for each discovered user skill', () => {
    const cwd = createTempCwd();
    const agentDir = createTempCwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const userSkillsDir = path.join(agentDir, 'skills');
    const skillA = createSkillDir(userSkillsDir, 'test-skill-a');
    const skillB = createSkillDir(userSkillsDir, 'test-skill-b');

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, { role: 'Tester', objective: 'Do something' }, 'test-session');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    // Collect all --skill values
    const skillValues: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--skill') {
        skillValues.push(args[i + 1]);
      }
    }

    expect(skillValues).toContain(skillA);
    expect(skillValues).toContain(skillB);
    expect(skillValues).toHaveLength(2);

    proc.emit('close', 0);
  });

  it('passes --skill for project skills', () => {
    const cwd = createTempCwd();
    // Override agent dir to empty temp so we don't pick up real user skills
    const agentDir = createTempCwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const projectSkillsDir = path.join(cwd, '.pi', 'skills');
    const skillC = createSkillDir(projectSkillsDir, 'project-skill');

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, { role: 'Tester', objective: 'Do something' }, 'test-session');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    const skillValues: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--skill') {
        skillValues.push(args[i + 1]);
      }
    }

    expect(skillValues).toContain(skillC);

    proc.emit('close', 0);
  });

  it('skips directories without SKILL.md', () => {
    const cwd = createTempCwd();
    const agentDir = createTempCwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const userSkillsDir = path.join(agentDir, 'skills');
    // Create a directory without SKILL.md (not a valid skill)
    fs.mkdirSync(path.join(userSkillsDir, 'not-a-skill'), { recursive: true });
    // And one valid skill
    const validSkill = createSkillDir(userSkillsDir, 'valid-skill');

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, { role: 'Tester', objective: 'Do something' }, 'test-session');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    const skillValues: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === '--skill') {
        skillValues.push(args[i + 1]);
      }
    }

    expect(skillValues).toEqual([validSkill]);

    proc.emit('close', 0);
  });

  it('passes no --skill when no skills exist', () => {
    const cwd = createTempCwd();
    const agentDir = createTempCwd();
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const proc = new FakeProcess();
    spawnMock.mockReturnValue(proc as any);

    spawnSubagent(cwd, { role: 'Tester', objective: 'Do something' }, 'test-session');

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const args = spawnMock.mock.calls[0][1] as string[];

    expect(args).not.toContain('--skill');

    proc.emit('close', 0);
  });
});
