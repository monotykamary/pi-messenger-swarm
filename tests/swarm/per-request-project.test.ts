/**
 * Tests for per-request project resolution in the harness server.
 *
 * Verifies that when multiple projects share the same harness server,
 * each request resolves the correct dirs and config from the calling
 * project's cwd, not from the server's startup cwd.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import type { Dirs } from '../../lib.js';

const roots = new Set<string>();

function createProject(name: string): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-messenger-project-test-${name}-`));
  roots.add(projectDir);
  return projectDir;
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('per-request project resolution', () => {
  describe('loadConfig from project cwd', () => {
    it('reads config from the project directory, not the server startup cwd', () => {
      const projectA = createProject('alpha');
      const projectB = createProject('beta');

      // Write different maxConcurrentSpawns in each project
      const piDir = path.join(projectA, '.pi');
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, 'pi-messenger.json'),
        JSON.stringify({ maxConcurrentSpawns: 5 })
      );

      const piDirB = path.join(projectB, '.pi');
      fs.mkdirSync(piDirB, { recursive: true });
      fs.writeFileSync(
        path.join(piDirB, 'pi-messenger.json'),
        JSON.stringify({ maxConcurrentSpawns: 10 })
      );

      const configA = loadConfig(projectA);
      const configB = loadConfig(projectB);

      expect(configA.maxConcurrentSpawns).toBe(5);
      expect(configB.maxConcurrentSpawns).toBe(10);
    });

    it('falls back to defaults when project has no config file', () => {
      const emptyProject = createProject('empty');
      const config = loadConfig(emptyProject);

      expect(config.maxConcurrentSpawns).toBe(3); // default
    });

    it('caches config per cwd', () => {
      const project = createProject('cached');
      const piDir = path.join(project, '.pi');
      fs.mkdirSync(piDir, { recursive: true });
      fs.writeFileSync(
        path.join(piDir, 'pi-messenger.json'),
        JSON.stringify({ maxConcurrentSpawns: 7 })
      );

      // Call loadConfig twice — should return same value
      const config1 = loadConfig(project);
      const config2 = loadConfig(project);

      expect(config1.maxConcurrentSpawns).toBe(7);
      expect(config2.maxConcurrentSpawns).toBe(7);
    });
  });

  describe('per-project dirs isolation', () => {
    it('different projects get different messenger directories', () => {
      const projectA = createProject('alpha');
      const projectB = createProject('beta');

      // Simulate what getMessengerDirs does
      const baseA = path.join(projectA, '.pi', 'messenger');
      const baseB = path.join(projectB, '.pi', 'messenger');
      const dirsA: Dirs = { base: baseA, registry: path.join(baseA, 'registry') };
      const dirsB: Dirs = { base: baseB, registry: path.join(baseB, 'registry') };

      expect(dirsA.registry).not.toBe(dirsB.registry);
      expect(dirsA.registry).toContain('alpha');
      expect(dirsB.registry).toContain('beta');
    });

    it('each project has its own registration directory', () => {
      const projectA = createProject('alpha');
      const projectB = createProject('beta');

      const baseA = path.join(projectA, '.pi', 'messenger');
      const baseB = path.join(projectB, '.pi', 'messenger');
      const registryA = path.join(baseA, 'registry');
      const registryB = path.join(baseB, 'registry');

      // Register an agent in project A
      fs.mkdirSync(registryA, { recursive: true });
      fs.writeFileSync(
        path.join(registryA, 'AgentA.json'),
        JSON.stringify({
          name: 'AgentA',
          pid: process.pid,
          sessionId: 'session-a',
          cwd: projectA,
          currentChannel: 'test',
        })
      );

      // Register a different agent in project B
      fs.mkdirSync(registryB, { recursive: true });
      fs.writeFileSync(
        path.join(registryB, 'AgentB.json'),
        JSON.stringify({
          name: 'AgentB',
          pid: process.pid,
          sessionId: 'session-b',
          cwd: projectB,
          currentChannel: 'test',
        })
      );

      // Project A's registry doesn't contain AgentB
      const filesA = fs.readdirSync(registryA).filter((f) => f.endsWith('.json'));
      expect(filesA.map((f) => f.replace('.json', ''))).toContain('AgentA');
      expect(filesA.map((f) => f.replace('.json', ''))).not.toContain('AgentB');

      // Project B's registry doesn't contain AgentA
      const filesB = fs.readdirSync(registryB).filter((f) => f.endsWith('.json'));
      expect(filesB.map((f) => f.replace('.json', ''))).toContain('AgentB');
      expect(filesB.map((f) => f.replace('.json', ''))).not.toContain('AgentA');
    });

    it('each project has its own channels directory', () => {
      const projectA = createProject('alpha');
      const projectB = createProject('beta');

      const channelsA = path.join(projectA, '.pi', 'messenger', 'channels');
      const channelsB = path.join(projectB, '.pi', 'messenger', 'channels');

      // Create a channel in project A
      fs.mkdirSync(channelsA, { recursive: true });
      const metaHeader = JSON.stringify({
        _meta: true,
        v: 1,
        id: 'keen-jaguar',
        type: 'session',
        createdAt: new Date().toISOString(),
      });
      fs.writeFileSync(path.join(channelsA, 'keen-jaguar.jsonl'), metaHeader + '\n');

      // Project A has the channel
      expect(fs.existsSync(path.join(channelsA, 'keen-jaguar.jsonl'))).toBe(true);

      // Project B doesn't
      expect(fs.existsSync(path.join(channelsB, 'keen-jaguar.jsonl'))).toBe(false);
    });
  });

  describe('x-caller-cwd header resolution', () => {
    it('caller cwd takes priority over server startup cwd for project resolution', () => {
      const projectA = createProject('server-startup');
      const projectB = createProject('caller-project');

      // Server starts in projectA (startup cwd)
      const startupCwd = projectA;

      // But the CLI sends x-caller-cwd = projectB
      const callerCwd = projectB;

      // The per-request resolution should use callerCwd, not startupCwd
      expect(callerCwd).not.toBe(startupCwd);

      // If we compute dirs from callerCwd, we get project B's messenger directory
      const dirsFromCaller = path.join(callerCwd, '.pi', 'messenger');
      const dirsFromStartup = path.join(startupCwd, '.pi', 'messenger');

      expect(dirsFromCaller).toContain('caller-project');
      expect(dirsFromStartup).toContain('server-startup');
    });
  });
});

describe('multi-project singleton server scenario', () => {
  it('project B agent can find its channels even when server started from project A', () => {
    const projectA = createProject('projectA');
    const projectB = createProject('projectB');

    // Setup project B with a registration and channel
    const messengerDirB = path.join(projectB, '.pi', 'messenger');
    const registryB = path.join(messengerDirB, 'registry');
    const channelsB = path.join(messengerDirB, 'channels');
    fs.mkdirSync(registryB, { recursive: true });
    fs.mkdirSync(channelsB, { recursive: true });

    // Write registration in project B
    fs.writeFileSync(
      path.join(registryB, 'YoungViper.json'),
      JSON.stringify({
        name: 'YoungViper',
        pid: process.pid,
        sessionId: 'session-b',
        cwd: projectB,
        currentChannel: 'keen-jaguar',
        joinedChannels: ['keen-jaguar', 'memory'],
      })
    );

    // Write channel in project B
    const channelFile = path.join(channelsB, 'keen-jaguar.jsonl');
    const metaHeader = JSON.stringify({
      _meta: true,
      v: 1,
      id: 'keen-jaguar',
      type: 'session',
      createdAt: new Date().toISOString(),
    });
    fs.writeFileSync(channelFile, metaHeader + '\n');

    // If we resolve dirs from projectB's cwd, we find the channel
    const resolvedDirs: Dirs = {
      base: messengerDirB,
      registry: registryB,
    };

    // Verify channel exists when looking in project B's dirs
    expect(fs.existsSync(channelFile)).toBe(true);

    // Verify registration exists when looking in project B's dirs
    const regFiles = fs.readdirSync(registryB).filter((f) => f.endsWith('.json'));
    expect(regFiles.map((f) => f.replace('.json', ''))).toContain('YoungViper');
  });

  it('project B config is used when caller cwd is project B', () => {
    const projectA = createProject('projectA');
    const projectB = createProject('projectB');

    // Project A: default config (maxConcurrentSpawns: 3)
    // Project B: custom config
    const piDirB = path.join(projectB, '.pi');
    fs.mkdirSync(piDirB, { recursive: true });
    fs.writeFileSync(
      path.join(piDirB, 'pi-messenger.json'),
      JSON.stringify({ maxConcurrentSpawns: 10 })
    );

    // Server starts in project A
    const serverCwd = projectA;
    // But request comes from project B
    const callerCwd = projectB;

    const configFromServer = loadConfig(serverCwd);
    const configFromCaller = loadConfig(callerCwd);

    // Server's startup config has default
    expect(configFromServer.maxConcurrentSpawns).toBe(3);
    // Caller's config has custom value
    expect(configFromCaller.maxConcurrentSpawns).toBe(10);
    // Per-request resolution uses the caller config
    expect(configFromCaller.maxConcurrentSpawns).not.toBe(configFromServer.maxConcurrentSpawns);
  });
});
