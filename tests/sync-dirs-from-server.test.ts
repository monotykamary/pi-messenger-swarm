/**
 * Tests for the syncDirsFromServer behaviour.
 *
 * Scenario: the harness server was started by a different pi session and its
 * dataDir differs from the extension's locally-computed dirs.base.  If the
 * extension does NOT sync, getActiveAgents reads the wrong (often empty)
 * registry and # autocomplete returns no peers even though `list` shows them.
 *
 * We verify:
 *  1. When dirs.base and the server's dataDir differ, dirs is updated in-place.
 *  2. When they already match, dirs is left untouched.
 *  3. When the server is unreachable, dirs is unchanged.
 *  4. When server returns no `dataDir` but has `cwd`, falls back to cwd-based path.
 *  5. Cross-project server (cwd mismatch) does not contaminate our registry.
 *  6. When local registry is empty, falls back to global ~/.pi/agent/messenger.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Dirs } from '../lib.js';
import { syncDirsFromServer } from '../extension/sync-dirs.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeDirs(base: string): Dirs {
  return { base, registry: join(base, 'registry') };
}

// hasAgents: local=false, global=false (neither has agents)
const noAgents = () => false;

// ── tests ─────────────────────────────────────────────────────────────────────

describe('syncDirsFromServer', () => {
  beforeEach(() => {
    delete process.env.PI_MESSENGER_PORT;
  });

  it('updates dirs.base and dirs.registry when server reports a different dataDir', async () => {
    const localDirs = makeDirs('/local/project/.pi/messenger');
    const serverDataDir = '/other/project/.pi/messenger';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, dataDir: serverDataDir }),
    });
    const hasAgents = (p: string) => p === join(serverDataDir, 'registry');

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(serverDataDir);
    expect(localDirs.registry).toBe(join(serverDataDir, 'registry'));
  });

  it('leaves dirs unchanged when server dataDir matches', async () => {
    const base = '/same/project/.pi/messenger';
    const localDirs = makeDirs(base);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, dataDir: base }),
    });
    const hasAgents = (p: string) => p === join(base, 'registry');

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(base);
    expect(localDirs.registry).toBe(join(base, 'registry'));
  });

  it('falls back to cwd-based path when server has no dataDir but cwd matches ours (older server)', async () => {
    const serverCwd = process.cwd();
    const expectedBase = join(serverCwd, '.pi', 'messenger');
    const localDirs = makeDirs('/tmp/stale/.pi/messenger');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, uptime: 100, cwd: serverCwd }),
    });
    const hasAgents = (p: string) => p === join(expectedBase, 'registry');

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(expectedBase);
    expect(localDirs.registry).toBe(join(expectedBase, 'registry'));
  });

  it('does NOT adopt cwd-based path when server cwd differs from ours (cross-project server)', async () => {
    const localBase = '/local/my-project/.pi/messenger';
    const localDirs = makeDirs(localBase);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, uptime: 100, cwd: '/other/project' }),
    });
    // Even if the foreign registry has agents, we must not adopt it.
    const hasAgents = (p: string) => p === '/other/project/.pi/messenger/registry';

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(localBase);
    expect(localDirs.registry).toBe(join(localBase, 'registry'));
  });

  it('falls back to global registry when local and server registries are empty', async () => {
    const localBase = '/local/.pi/messenger';
    const localDirs = makeDirs(localBase);
    const globalBase = join(homedir(), '.pi', 'agent', 'messenger');
    const globalRegistry = join(globalBase, 'registry');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, uptime: 100 }),
    });
    const hasAgents = (p: string) => p === globalRegistry;

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(globalBase);
    expect(localDirs.registry).toBe(globalRegistry);
  });

  it('does NOT fall back to global when local registry already has agents', async () => {
    const localBase = '/local/.pi/messenger';
    const localDirs = makeDirs(localBase);
    const globalRegistry = join(homedir(), '.pi', 'agent', 'messenger', 'registry');

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, uptime: 100 }),
    });
    const hasAgents = (p: string) => p === join(localBase, 'registry') || p === globalRegistry;

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(localDirs.base).toBe(localBase);
    expect(localDirs.registry).toBe(join(localBase, 'registry'));
  });

  it('leaves dirs unchanged when the server is unreachable and global is empty', async () => {
    const base = '/local/.pi/messenger';
    const localDirs = makeDirs(base);

    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    // Must not throw — errors are absorbed inside syncDirsFromServer.
    await expect(
      syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, noAgents)
    ).resolves.toBeUndefined();

    expect(localDirs.base).toBe(base);
  });

  it('leaves dirs unchanged when health returns non-200 and global is empty', async () => {
    const base = '/local/.pi/messenger';
    const localDirs = makeDirs(base);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, noAgents);

    expect(localDirs.base).toBe(base);
  });

  it('uses PI_MESSENGER_PORT env var when set', async () => {
    process.env.PI_MESSENGER_PORT = '19877';
    const localDirs = makeDirs('/local/.pi/messenger');
    const serverDataDir = '/remote/.pi/messenger';

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ dataDir: serverDataDir }),
    });
    const hasAgents = (p: string) => p === join(serverDataDir, 'registry');

    await syncDirsFromServer(localDirs, mockFetch as unknown as typeof fetch, hasAgents);

    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:19877/health');
    expect(localDirs.base).toBe(serverDataDir);
  });
});
