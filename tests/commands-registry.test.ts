/**
 * Drift-detection test: every CLI command registered in COMMAND_REGISTRY must
 * have a corresponding `case` (or `if group === …`) in harness/cli.ts, and
 * every router action in COMMAND_REGISTRY must be reachable via router.ts.
 *
 * This test is deliberately simple — it parses source text via regex rather
 * than importing live code, so it works without a running harness server and
 * catches drift in both directions.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { COMMAND_REGISTRY, splitCliArgs, findCommandSpec } from '../harness/commands.js';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..');
const CLI_SRC = fs.readFileSync(path.join(ROOT, 'harness', 'cli.ts'), 'utf-8');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'router.ts'), 'utf-8');

// ── Registry integrity ─────────────────────────────────────────────────────

describe('COMMAND_REGISTRY integrity', () => {
  it('has no duplicate cmd entries', () => {
    const cmds = COMMAND_REGISTRY.map((s) => s.cmd);
    const duplicates = cmds.filter((c, i) => cmds.indexOf(c) !== i);
    expect(duplicates).toEqual([]);
  });

  it('has no duplicate action entries', () => {
    const actions = COMMAND_REGISTRY.map((s) => s.action);
    const duplicates = actions.filter((a, i) => actions.indexOf(a) !== i);
    expect(duplicates).toEqual([]);
  });

  it('every cmd maps to a plausible action (dot-form)', () => {
    for (const { cmd, action } of COMMAND_REGISTRY) {
      // Top-level: 'status' → 'status', 'task list' → 'task.list'
      const expectedAction = cmd.replace(' ', '.');
      // Allow exact match or known mapping (e.g. set-status → set_status, archive-done → archive_done)
      const normalized = expectedAction.replace(/-/g, '_');
      const actionNorm = action.replace(/-/g, '_');
      expect(actionNorm).toMatch(/^[a-z_]+(\.[a-z_]+)?$/);
      // Action must start with the first word of cmd
      const firstWord = cmd.split(' ')[0].replace(/-/g, '_');
      expect(actionNorm).toMatch(new RegExp(`^${firstWord}`));
    }
  });
});

// ── CLI drift detection ────────────────────────────────────────────────────

describe('COMMAND_REGISTRY ↔ harness/cli.ts drift', () => {
  // Extract top-level case labels from cli.ts: case 'foo': or case "foo":
  const cliCases = new Set([...CLI_SRC.matchAll(/case ['"]([^'"]+)['"]\s*:/g)].map((m) => m[1]));

  // Collect unique top-level CLI commands from registry
  const topLevelCommands = new Set(COMMAND_REGISTRY.map((s) => s.cmd.split(' ')[0]));

  it('every top-level registry command exists as a case in cli.ts', () => {
    const missing: string[] = [];
    for (const cmd of topLevelCommands) {
      // Normalize: set-status → both 'set-status' and 'set_status' are ok
      if (!cliCases.has(cmd) && !cliCases.has(cmd.replace(/-/g, '_'))) {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ── Router drift detection ─────────────────────────────────────────────────

describe('COMMAND_REGISTRY ↔ router.ts drift', () => {
  // Extract switch case groups from router.ts
  const routerCases = new Set(
    [...ROUTER_SRC.matchAll(/case ['"]([^'"]+)['"]\s*:/g)].map((m) => m[1])
  );
  routerCases.add('join');
  routerCases.add('autoRegisterPath');

  it('every registry top-level action group exists in router.ts', () => {
    const missing: string[] = [];
    for (const { action } of COMMAND_REGISTRY) {
      const group = action.includes('.') ? action.split('.')[0] : action;
      // Normalize set_status → set_status matches case 'set_status'
      if (!routerCases.has(group) && !routerCases.has(group.replace(/_/g, '-'))) {
        missing.push(`${action} (group: ${group})`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// ── splitCliArgs ───────────────────────────────────────────────────────────

describe('splitCliArgs', () => {
  it('splits naive commands without a rest+ arg normally', () => {
    expect(splitCliArgs('status')).toEqual(['status']);
    expect(splitCliArgs('task list')).toEqual(['task', 'list']);
    expect(splitCliArgs('task show task-1')).toEqual(['task', 'show', 'task-1']);
  });

  it('joins rest+ args into a single token', () => {
    // task done: args = ['id', 'summary+']
    expect(splitCliArgs('task done task-1 my summary text')).toEqual([
      'task',
      'done',
      'task-1',
      'my summary text',
    ]);
    // task progress: args = ['id', 'message+']
    expect(splitCliArgs('task progress task-2 fixed the race condition')).toEqual([
      'task',
      'progress',
      'task-2',
      'fixed the race condition',
    ]);
    // set-status: args = ['message+']
    expect(splitCliArgs('set-status reviewing the PR')).toEqual(['set-status', 'reviewing the PR']);
    // send: args = ['to', 'message+']
    expect(splitCliArgs('send Alice hello world')).toEqual(['send', 'Alice', 'hello world']);
  });

  it('passes flag tokens through as separate tokens (flags take one value each)', () => {
    // task block has args: ['id'] and no rest+ — flags are not joined.
    // CLI's extractFlag('reason') takes just the next token ('awaiting').
    expect(splitCliArgs('task block task-3 --reason blocked')).toEqual([
      'task',
      'block',
      'task-3',
      '--reason',
      'blocked',
    ]);
    // task reset: args: ['id'], flags: ['cascade'] — cascade is a boolean flag
    expect(splitCliArgs('task reset task-4 --cascade')).toEqual([
      'task',
      'reset',
      'task-4',
      '--cascade',
    ]);
  });

  it('falls back to naive split for unknown commands', () => {
    expect(splitCliArgs('unknown foo bar baz')).toEqual(['unknown', 'foo', 'bar', 'baz']);
  });
});

// ── findCommandSpec ────────────────────────────────────────────────────────

describe('findCommandSpec', () => {
  it('finds top-level commands', () => {
    expect(findCommandSpec('status')?.action).toBe('status');
    expect(findCommandSpec('feed')?.action).toBe('feed');
  });

  it('prefers the most specific (longest) match', () => {
    expect(findCommandSpec('task done task-1 summary')?.action).toBe('task.done');
    expect(findCommandSpec('spawn list')?.action).toBe('spawn.list');
    expect(findCommandSpec('spawn stop abc-123')?.action).toBe('spawn.stop');
  });

  it('returns undefined for unknown commands', () => {
    expect(findCommandSpec('bogus')).toBeUndefined();
  });
});
