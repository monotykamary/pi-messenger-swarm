import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRegistration, Dirs, MessengerState } from '../lib.js';
import { getActiveAgents, invalidateAgentsCache } from '../store.js';

const roots = new Set<string>();
const initialCwd = process.cwd();

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-store-test-'));
  roots.add(root);
  return root;
}

function createDirs(root: string): Dirs {
  const base = path.join(root, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  fs.mkdirSync(registry, { recursive: true });
  return { base, registry };
}

function createState(scopeToFolder: boolean): MessengerState {
  return {
    agentName: 'Self',
    scopeToFolder,
  } as MessengerState;
}

function writeRegistration(registryDir: string, name: string, cwd: string): void {
  const registration: AgentRegistration = {
    name,
    pid: process.pid,
    sessionId: 'session-1',
    cwd,
    model: 'test-model',
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

afterEach(() => {
  invalidateAgentsCache();
  process.chdir(initialCwd);
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

// A pid that is almost certainly not running on any test machine.
// macOS kern.maxprocperuid is ~2784; Linux /proc/sys/kernel/pid_max is 4M max.
// 99999999 is safely above both.
const DEAD_PID = 99999999;

function writeDeadRegistration(registryDir: string, name: string, cwd: string): void {
  const registration: AgentRegistration = {
    name,
    pid: DEAD_PID,
    sessionId: 'dead-session',
    cwd,
    model: 'test-model',
    startedAt: new Date().toISOString(),
    isHuman: false,
    session: { toolCalls: 0, tokens: 0, filesModified: [] },
    activity: { lastActivityAt: new Date().toISOString() },
  };
  fs.writeFileSync(path.join(registryDir, `${name}.json`), JSON.stringify(registration));
}

describe('store.getActiveAgents gc option', () => {
  it('gc:false — returns dead-process agent without deleting its registry file', () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    writeDeadRegistration(dirs.registry, 'GhostAgent', process.cwd());

    const agents = getActiveAgents(createState(false), dirs, { gc: false });
    expect(agents.map((a) => a.name)).toContain('GhostAgent');
    expect(fs.existsSync(path.join(dirs.registry, 'GhostAgent.json'))).toBe(true);
  });

  it('gc:true (default) — excludes dead-process agent and deletes its registry file', () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const regPath = path.join(dirs.registry, 'GhostAgent.json');
    writeDeadRegistration(dirs.registry, 'GhostAgent', process.cwd());

    const agents = getActiveAgents(createState(false), dirs);
    expect(agents.map((a) => a.name)).not.toContain('GhostAgent');
    expect(fs.existsSync(regPath)).toBe(false);
  });

  it('gc:false — still excludes self (agentName filter is independent of gc)', () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    // Write Self with alive pid — should still be excluded as self
    writeRegistration(dirs.registry, 'Self', process.cwd());

    const agents = getActiveAgents(createState(false), dirs, { gc: false });
    expect(agents.map((a) => a.name)).not.toContain('Self');
  });
});

describe('store.getActiveAgents cwd scoping', () => {
  it('matches scoped agents using canonical cwd', () => {
    const root = createTempRoot();
    const dirs = createDirs(root);
    const actualProject = path.join(root, 'project');
    const aliasProject = path.join(root, 'project-alias');

    fs.mkdirSync(actualProject, { recursive: true });
    fs.symlinkSync(actualProject, aliasProject, 'dir');

    writeRegistration(dirs.registry, 'Peer', actualProject);

    process.chdir(aliasProject);
    const agents = getActiveAgents(createState(true), dirs);

    expect(agents.map((agent) => agent.name)).toEqual(['Peer']);
  });
});
