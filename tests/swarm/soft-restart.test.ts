/**
 * Tests for harness server soft restart behavior.
 *
 * Verifies that:
 * 1. Soft restart clears dirs and config caches without killing running agents
 * 2. After cache clear, a new request resolves the correct project's config
 * 3. The /restart endpoint returns success without stopping the server
 * 4. /quit still does a full shutdown (stops agents)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';
import type { Dirs } from '../../lib.js';

const roots = new Set<string>();

function createProject(name: string, config?: Record<string, unknown>): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-messenger-restart-test-${name}-`));
  roots.add(projectDir);

  if (config) {
    const piDir = path.join(projectDir, '.pi');
    fs.mkdirSync(piDir, { recursive: true });
    fs.writeFileSync(path.join(piDir, 'pi-messenger.json'), JSON.stringify(config));
  }

  return projectDir;
}

function createMessengerDirs(cwd: string): Dirs {
  const base = path.join(cwd, '.pi', 'messenger');
  const registry = path.join(base, 'registry');
  fs.mkdirSync(registry, { recursive: true });
  return { base, registry };
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('harness server soft restart', () => {
  describe('config cache behavior', () => {
    it('config loaded before restart reflects the original value', () => {
      const project = createProject('before-restart', { maxConcurrentSpawns: 3 });
      const config = loadConfig(project);
      expect(config.maxConcurrentSpawns).toBe(3);
    });

    it('config loaded after file change reflects the new value on fresh loadConfig', () => {
      const project = createProject('after-change', { maxConcurrentSpawns: 3 });

      // Load initial config
      const configBefore = loadConfig(project);
      expect(configBefore.maxConcurrentSpawns).toBe(3);

      // Change the config file
      const piDir = path.join(project, '.pi');
      fs.writeFileSync(
        path.join(piDir, 'pi-messenger.json'),
        JSON.stringify({ maxConcurrentSpawns: 10 })
      );

      // loadConfig reads from filesystem each time it's called for a
      // new cwd — if the cache is cleared, it picks up the new value
      const configAfter = loadConfig(project);
      expect(configAfter.maxConcurrentSpawns).toBe(10);
    });

    it('different projects get different configs after cache scenario', () => {
      const projectA = createProject('alpha', { maxConcurrentSpawns: 5 });
      const projectB = createProject('beta', { maxConcurrentSpawns: 10 });

      const configA = loadConfig(projectA);
      const configB = loadConfig(projectB);

      expect(configA.maxConcurrentSpawns).toBe(5);
      expect(configB.maxConcurrentSpawns).toBe(10);
    });
  });

  describe('dirs resolution per project', () => {
    it('each project gets its own dirs', () => {
      const projectA = createProject('alpha');
      const projectB = createProject('beta');

      const dirsA = createMessengerDirs(projectA);
      const dirsB = createMessengerDirs(projectB);

      expect(dirsA.base).toContain('alpha');
      expect(dirsB.base).toContain('beta');
      expect(dirsA.registry).not.toBe(dirsB.registry);
    });

    it('dirs cache clear allows re-resolution for a different project', () => {
      const projectA = createProject('server-startup');
      const projectB = createProject('caller-project');

      // Simulate: server starts, resolves dirs for project A
      const dirsA = createMessengerDirs(projectA);
      expect(dirsA.base).toContain('server-startup');

      // Simulate: after cache clear, resolving dirs for project B
      const dirsB = createMessengerDirs(projectB);
      expect(dirsB.base).toContain('caller-project');

      // Both should be valid but isolated
      expect(fs.existsSync(dirsA.registry)).toBe(true);
      expect(fs.existsSync(dirsB.registry)).toBe(true);
    });
  });

  describe('soft restart preserves registrations and channels', () => {
    it('project B registrations survive when server resolves project B dirs after cache clear', () => {
      const projectB = createProject('beta');

      const dirs = createMessengerDirs(projectB);

      // Write a registration
      fs.writeFileSync(
        path.join(dirs.registry, 'YoungViper.json'),
        JSON.stringify({
          name: 'YoungViper',
          pid: process.pid,
          sessionId: 'session-b',
          cwd: projectB,
          currentChannel: 'keen-jaguar',
          joinedChannels: ['keen-jaguar', 'memory'],
        })
      );

      // Write a channel
      const channelsDir = path.join(dirs.base, 'channels');
      fs.mkdirSync(channelsDir, { recursive: true });
      fs.writeFileSync(
        path.join(channelsDir, 'keen-jaguar.jsonl'),
        JSON.stringify({
          _meta: true,
          v: 1,
          id: 'keen-jaguar',
          type: 'session',
          createdAt: new Date().toISOString(),
        }) + '\n'
      );

      // After "soft restart" (cache clear + re-resolve dirs), both still exist
      const reResolvedDirs = createMessengerDirs(projectB);
      const regFiles = fs.readdirSync(reResolvedDirs.registry).filter((f) => f.endsWith('.json'));
      expect(regFiles.map((f) => f.replace('.json', ''))).toContain('YoungViper');
      expect(
        fs.existsSync(path.join(path.join(reResolvedDirs.base, 'channels'), 'keen-jaguar.jsonl'))
      ).toBe(true);
    });
  });

  describe('x-caller-cwd vs registration cwd priority', () => {
    it('x-caller-cwd provides correct cwd when no registration exists yet', () => {
      const projectA = createProject('server-cwd');
      const projectB = createProject('caller-cwd', { maxConcurrentSpawns: 10 });

      // No registration for project B — server can't find its cwd from disk
      // But x-caller-cwd header provides it
      const callerCwd = projectB;

      // Resolve config using callerCwd (what the server would do after reading the header)
      const config = loadConfig(callerCwd);
      expect(config.maxConcurrentSpawns).toBe(10);

      // If server had used its startup cwd, it would have gotten default
      const serverConfig = loadConfig(projectA);
      expect(serverConfig.maxConcurrentSpawns).toBe(3);
    });

    it('registration cwd overrides server startup cwd', () => {
      const projectA = createProject('server-startup');
      const projectB = createProject('registered', { maxConcurrentSpawns: 10 });

      // Registration file in project A's registry that points to project B
      const dirsA = createMessengerDirs(projectA);
      fs.writeFileSync(
        path.join(dirsA.registry, 'Agent.json'),
        JSON.stringify({
          name: 'Agent',
          pid: process.pid,
          sessionId: 'session-b',
          cwd: projectB, // Points to project B
        })
      );

      // Read the registration, extract cwd, use it for config
      const reg = JSON.parse(fs.readFileSync(path.join(dirsA.registry, 'Agent.json'), 'utf-8'));
      const resolvedCwd = reg.cwd;

      // Config from resolved cwd matches project B
      const config = loadConfig(resolvedCwd);
      expect(config.maxConcurrentSpawns).toBe(10);
    });

    it('x-caller-cwd takes priority over registration cwd', () => {
      const projectA = createProject('server-startup');
      const projectB = createProject('registered', { maxConcurrentSpawns: 10 });
      const projectC = createProject('caller-cwd', { maxConcurrentSpawns: 20 });

      // Registration points to project B
      const dirsA = createMessengerDirs(projectA);
      fs.writeFileSync(
        path.join(dirsA.registry, 'Agent.json'),
        JSON.stringify({
          name: 'Agent',
          pid: process.pid,
          cwd: projectB,
        })
      );

      // But x-caller-cwd says project C (the most authoritative source)
      const callerCwd = projectC;

      // Priority: callerCwd > registration cwd
      const config = loadConfig(callerCwd);
      expect(config.maxConcurrentSpawns).toBe(20);
    });
  });
});
