/**
 * Unit tests for createMentionAutocompleteProvider (pi-tui autocomplete API).
 *
 * Tests the getSuggestions / applyCompletion / shouldTriggerFileCompletion
 * methods that power the # and ## completions in pi's main input editor.
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

// vi.hoisted runs before vi.mock factories, allowing the mock function to be
// referenced inside the factory and overridden in individual tests.
const getActiveAgentsMock = vi.hoisted(() =>
  vi.fn(() => [{ name: 'coral-fox' }, { name: 'amber-wolf' }])
);
const getLiveWorkersMock = vi.hoisted(() => vi.fn(() => new Map()));

vi.mock('../store.js', () => ({
  getActiveAgents: getActiveAgentsMock,
  getClaims: () => ({}),
}));
vi.mock('../channel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel.js')>();
  return { ...actual, agentNameToChannelId: (name: string) => name.toLowerCase() };
});
vi.mock('../swarm/live-progress.js', () => ({
  getLiveWorkers: getLiveWorkersMock,
  hasLiveWorkers: () => false,
  onLiveWorkersChanged: () => () => {},
}));
vi.mock('../feed/index.js', () => ({
  logFeedEvent: vi.fn(),
  readFeedEvents: () => [],
}));
vi.mock('../lib.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib.js')>();
  return { ...actual, isProcessAlive: (pid: number) => pid === process.pid };
});

import { createMentionAutocompleteProvider } from '../extension/mention-autocomplete.js';
import type { AutocompleteProvider } from '@earendil-works/pi-tui';
import type { MessengerState, Dirs } from '../lib.js';
import { beforeEach } from 'vitest';

// Reset the dynamic mock to the default two-agent list before each test so
// tests that override it (e.g. dirs-mismatch scenarios) don't pollute others.
beforeEach(() => {
  getActiveAgentsMock.mockReturnValue([{ name: 'coral-fox' }, { name: 'amber-wolf' }]);
});

const noopProvider: AutocompleteProvider = {
  async getSuggestions() {
    return null;
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    return { lines, cursorLine, cursorCol };
  },
  shouldTriggerFileCompletion() {
    return false;
  },
};

function makeProvider() {
  const state = { agentName: 'me', scopeToFolder: false } as MessengerState;
  const dirs: Dirs = { base: '/tmp', registry: '/tmp/reg' };
  const factory = createMentionAutocompleteProvider(state, dirs);
  return factory(noopProvider);
}

function suggest(provider: AutocompleteProvider, text: string) {
  const lines = [text];
  const cursorCol = text.length;
  const ctrl = new AbortController();
  return provider.getSuggestions(lines, 0, cursorCol, { signal: ctrl.signal });
}

function triggerTab(provider: AutocompleteProvider, text: string) {
  const lines = [text];
  return provider.shouldTriggerFileCompletion!(lines, 0, text.length);
}

// ── # context (agents) ────────────────────────────────────────────────────────

describe('# mention context', () => {
  it('returns agents and ## gateway for bare #', async () => {
    const p = makeProvider();
    const result = await suggest(p, '#');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('#coral-fox');
    expect(labels).toContain('#all');
    expect(labels).toContain('##');
    expect(result!.prefix).toBe('#');
  });

  it('hides ## gateway when user has typed an agent prefix (focused filtering)', async () => {
    // ## is only shown on a bare `#`. Once the user starts typing a name
    // (e.g. `#cor`) the list should focus on matching agents only.
    const p = makeProvider();
    const result = await suggest(p, '#cor');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('#coral-fox');
    expect(labels).not.toContain('##');
  });

  it('returns null when no agent matches the prefix (## gateway hidden during filtering)', async () => {
    const p = makeProvider();
    // 'z' matches no agent and ## is hidden during prefix filtering → null
    const result = await suggest(p, '#z');
    expect(result).toBeNull();
  });

  it('suppresses Tab file completion in # context', () => {
    const p = makeProvider();
    expect(triggerTab(p, '#coral-fox')).toBe(false);
  });

  it('shows ## gateway only on bare # (nothing typed yet)', async () => {
    const p = makeProvider();
    const result = await suggest(p, '#');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('##');
  });

  it('suppresses autocomplete suggestions in #mention message body', async () => {
    // After `#coral-fox ` the singleMatch regex exits mention mode.
    // File/default completions should be suppressed so the chat message
    // body stays clean.
    const p = makeProvider();
    const result = await suggest(p, '#coral-fox ');
    expect(result).toBeNull();
  });

  it('suppresses Tab file completion in #mention message body', () => {
    const p = makeProvider();
    expect(triggerTab(p, '#coral-fox ')).toBe(false);
  });
});

// ── ## context (CLI commands) ─────────────────────────────────────────────────

describe('## CLI command context', () => {
  it('returns top-level commands for bare ##', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('##list');
    expect(labels).toContain('##status');
    expect(labels).toContain('##task'); // group, not ##task list
    expect(labels).toContain('##spawn');
    // Should NOT contain compound commands like ##task list at top level
    expect(labels).not.toContain('##task list');
    expect(result!.prefix).toBe('##');
  });

  it('deduplicates top-level: task appears once even though task list/show/… exist', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##');
    const taskItems = result!.items.filter((i) => i.label.startsWith('##task'));
    const labels = taskItems.map((i) => i.label);
    expect(labels).toEqual(['##task']); // exactly one
  });

  it('filters top-level commands by typed prefix', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##ta');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toEqual(['##task']);
  });

  it('returns subcommands when typed has a space (##task )', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##task ');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('##task list');
    expect(labels).toContain('##task create');
    expect(labels).toContain('##task done');
    expect(result!.prefix).toBe('##task ');
  });

  it('filters subcommands by full prefix (##task l)', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##task l');
    expect(result).not.toBeNull();
    const labels = result!.items.map((i) => i.label);
    expect(labels).toEqual(['##task list']);
    expect(result!.prefix).toBe('##task l');
  });

  it('enables Tab in ## context (no space)', () => {
    const p = makeProvider();
    expect(triggerTab(p, '##task')).toBe(true);
  });

  it('enables Tab in ## context (with space)', () => {
    const p = makeProvider();
    expect(triggerTab(p, '##task ')).toBe(true);
  });

  it('returns null when no command matches', async () => {
    const p = makeProvider();
    const result = await suggest(p, '##zzz');
    expect(result).toBeNull();
  });
});

// ── applyCompletion ───────────────────────────────────────────────────────────

describe('applyCompletion', () => {
  it('replaces ## prefix with selected item value', () => {
    const p = makeProvider();
    const lines = ['##ta'];
    const item = { value: '##task ', label: '##task', description: '' };
    const result = p.applyCompletion(lines, 0, 4, item, '##ta');
    expect(result.lines[0]).toBe('##task ');
    expect(result.cursorCol).toBe(7);
  });

  it('replaces # prefix with selected agent value', () => {
    const p = makeProvider();
    const lines = ['#cor'];
    const item = { value: '#coral-fox ', label: '#coral-fox', description: '' };
    const result = p.applyCompletion(lines, 0, 4, item, '#cor');
    expect(result.lines[0]).toBe('#coral-fox ');
    expect(result.cursorCol).toBe(11);
  });
});

// ── dirs-mismatch regression ──────────────────────────────────────────────────
//
// Bug: when the harness server uses a different dataDir than the extension's
// locally-computed dirs, getActiveAgents reads the wrong (empty) registry.
// The # autocomplete would only ever show ## and #all, even though
// `pi_messenger list` returned real peers.
//
// Fix: index.ts queries /health after harness start and mutates dirs in-place.
// Because dirs is captured by reference in the provider closure, the provider
// automatically picks up the updated registry path on the next getSuggestions
// call — no re-registration of the provider is needed.

describe('# mention autocomplete — dirs-mismatch regression', () => {
  it('shows no peers when getActiveAgents returns empty (wrong registry)', async () => {
    getActiveAgentsMock.mockReturnValue([]);

    const state = { agentName: 'me', scopeToFolder: false } as MessengerState;
    const dirs: Dirs = { base: '/wrong/.pi/messenger', registry: '/wrong/.pi/messenger/registry' };
    const factory = createMentionAutocompleteProvider(state, dirs);
    const provider = factory(noopProvider);

    const result = await suggest(provider, '#');
    // Only the ## gateway and #all should appear — no agent items.
    const labels = result!.items.map((i) => i.label);
    expect(labels).not.toContain('#coral-fox');
    expect(labels).not.toContain('#amber-wolf');
    expect(labels).toContain('##');
  });

  it('shows peers immediately after dirs is updated in-place (simulates syncDirsFromServer)', async () => {
    // Start with wrong dirs → no agents returned.
    getActiveAgentsMock.mockReturnValue([]);

    const state = { agentName: 'me', scopeToFolder: false } as MessengerState;
    const dirs: Dirs = { base: '/wrong/.pi/messenger', registry: '/wrong/.pi/messenger/registry' };
    const factory = createMentionAutocompleteProvider(state, dirs);
    const provider = factory(noopProvider);

    // Confirm the pre-fix state: no agents.
    const before = await suggest(provider, '#');
    expect(before!.items.map((i) => i.label)).not.toContain('#swift-phoenix');

    // Simulate syncDirsFromServer mutating dirs in-place with the server's dataDir.
    const correctBase = '/correct/.pi/messenger';
    dirs.base = correctBase;
    dirs.registry = join(correctBase, 'registry');

    // Now make getActiveAgents return SwiftPhoenix (as if the correct registry
    // has its registration file).
    getActiveAgentsMock.mockReturnValue([{ name: 'SwiftPhoenix' }]);

    // Same provider instance — no re-registration needed.
    const after = await suggest(provider, '#');
    const labels = after!.items.map((i) => i.label);
    expect(labels).toContain('#swiftphoenix'); // agentNameToChannelId mock lowercases
  });

  it('shows peers immediately for the same provider when new agents register after creation', async () => {
    // Provider created when only coral-fox is online.
    getActiveAgentsMock.mockReturnValue([{ name: 'coral-fox' }]);

    const state = { agentName: 'me', scopeToFolder: false } as MessengerState;
    const dirs: Dirs = { base: '/p/.pi/messenger', registry: '/p/.pi/messenger/registry' };
    const factory = createMentionAutocompleteProvider(state, dirs);
    const provider = factory(noopProvider);

    // amber-wolf joins later (new registry file written).
    getActiveAgentsMock.mockReturnValue([{ name: 'coral-fox' }, { name: 'amber-wolf' }]);

    const result = await suggest(provider, '#');
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('#coral-fox');
    expect(labels).toContain('#amber-wolf'); // visible without re-creating the provider
  });
});

// ── ghost live worker (stale dead-pid) regression ────────────────────────────────────────────
//
// Bug: a spawned agent whose process crashed without calling removeLiveWorker
// would persist in the liveWorkers map and appear in `#` autocomplete
// suggestions even though the process was long dead.
//
// Fix: collectChannelCandidates checks isProcessAlive(info.pid) and skips
// workers with a dead pid.  Workers with no pid (legacy / test-injected) are
// treated as alive for backward compatibility.

describe('# mention autocomplete — ghost live worker regression', () => {
  beforeEach(() => {
    getActiveAgentsMock.mockReturnValue([{ name: 'coral-fox' }, { name: 'amber-wolf' }]);
    getLiveWorkersMock.mockReturnValue(new Map());
  });

  it('excludes a live worker whose pid is dead from getSuggestions', async () => {
    getLiveWorkersMock.mockReturnValue(
      new Map([['task-dead', { name: 'swift-raven', taskId: 'task-dead', pid: 99999999 }]])
    );
    const p = makeProvider();
    const result = await suggest(p, '#swift');
    // swift-raven should be absent — its pid is dead
    const labels = result?.items.map((i) => i.label) ?? [];
    expect(labels).not.toContain('#swift-raven');
  });

  it('includes a live worker whose pid matches the current process', async () => {
    getLiveWorkersMock.mockReturnValue(
      new Map([['task-alive', { name: 'jade-elk', taskId: 'task-alive', pid: process.pid }]])
    );
    const p = makeProvider();
    const result = await suggest(p, '#jade');
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('#jade-elk');
  });

  it('includes a worker with no pid field (legacy / backward-compat)', async () => {
    getLiveWorkersMock.mockReturnValue(
      new Map([['task-legacy', { name: 'old-worker', taskId: 'task-legacy' }]])
    );
    const p = makeProvider();
    const result = await suggest(p, '#old');
    const labels = result!.items.map((i) => i.label);
    expect(labels).toContain('#old-worker');
  });

  it('shows alive workers while filtering dead ones in the same map', async () => {
    getLiveWorkersMock.mockReturnValue(
      new Map([
        ['task-dead', { name: 'swift-raven', taskId: 'task-dead', pid: 99999999 }],
        ['task-alive', { name: 'jade-elk', taskId: 'task-alive', pid: process.pid }],
      ])
    );
    const p = makeProvider();
    const result = await suggest(p, '#');
    const labels = result!.items.map((i) => i.label);
    expect(labels).not.toContain('#swift-raven');
    expect(labels).toContain('#jade-elk');
  });
});
