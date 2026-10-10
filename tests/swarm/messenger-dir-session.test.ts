/**
 * Channel → session lookup must read from the same messenger root that
 * channels are written to. With PI_MESSENGER_DIR set, a spawned subagent
 * (`--no-session`, inherited channel) previously looked for the channel
 * header under `<cwd>/.pi/messenger`, missed it, fell back to an empty
 * session id and could not see (or claim) the parent's tasks.
 *
 * Regression for https://github.com/monotykamary/pi-messenger-swarm/issues/8
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Dirs, MessengerState } from '../../lib.js';
import { ensureSessionChannel, writeChannel } from '../../channel.js';
import {
  getEffectiveSessionId,
  getProjectChannelSessionId,
  resolveMessengerBaseDir,
} from '../../store/shared.js';
import * as taskStore from '../../swarm/task-store.js';
import { executeTaskAction } from '../../swarm/task-actions.js';

const ENV_KEYS = ['PI_MESSENGER_DIR', 'PI_MESSENGER_GLOBAL', 'PI_CODING_AGENT_DIR'] as const;
const savedEnv: Record<string, string | undefined> = {};
const roots = new Set<string>();

function tempDir(label: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `pi-messenger-${label}-`)));
  roots.add(dir);
  return dir;
}

function dirsFor(base: string): Dirs {
  return { base, registry: path.join(base, 'registry') };
}

function childState(channel: string): MessengerState {
  // Mirrors a spawned `pi --no-session` child: no context session id,
  // channel inherited from the parent via PI_MESSENGER_CHANNEL.
  return {
    currentChannel: channel,
    sessionChannel: channel,
    contextSessionId: '',
  } as unknown as MessengerState;
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});

describe('resolveMessengerBaseDir', () => {
  it('defaults to the project-scoped <cwd>/.pi/messenger', () => {
    expect(resolveMessengerBaseDir('/some/project')).toBe(
      path.join('/some/project', '.pi', 'messenger')
    );
  });

  it('uses the legacy global directory when PI_MESSENGER_GLOBAL=1', () => {
    const agentDir = tempDir('agent');
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MESSENGER_GLOBAL = '1';
    expect(resolveMessengerBaseDir('/some/project')).toBe(path.join(agentDir, 'messenger'));
  });

  it('prefers PI_MESSENGER_DIR over global and project-scoped modes', () => {
    const custom = tempDir('custom');
    process.env.PI_MESSENGER_DIR = custom;
    process.env.PI_MESSENGER_GLOBAL = '1';
    expect(resolveMessengerBaseDir('/some/project')).toBe(custom);
  });
});

describe('channel session lookup with PI_MESSENGER_DIR', () => {
  it('reads the channel header from PI_MESSENGER_DIR', () => {
    const custom = tempDir('custom');
    process.env.PI_MESSENGER_DIR = custom;
    const channel = writeChannel(dirsFor(custom), {
      id: 'shared-channel',
      type: 'session',
      createdAt: new Date().toISOString(),
      sessionId: 'parent-session',
    });

    expect(getProjectChannelSessionId('/wrong/project', `#${channel.id}`)).toBe('parent-session');
  });

  it('lets a --no-session child resolve and claim the parent task', () => {
    const custom = tempDir('custom');
    const cwd = tempDir('project');
    process.env.PI_MESSENGER_DIR = custom;

    // Parent: session channel lives under PI_MESSENGER_DIR, task created in its session.
    const channel = ensureSessionChannel(dirsFor(custom), 'parent-session');
    const task = taskStore.createTask(cwd, 'parent-session', { title: 'Delegated' }, channel.id);

    // Child: no session of its own, inherited channel.
    const childSessionId = getEffectiveSessionId(cwd, childState(channel.id));
    expect(childSessionId).toBe('parent-session');

    const res = executeTaskAction(cwd, childSessionId, 'start', task.id, 'Child', channel.id);
    expect(res.success).toBe(true);
    expect(res.task?.claimed_by).toBe('Child');
  });

  it('still finds headers in the project-scoped location', () => {
    const custom = tempDir('custom');
    const cwd = tempDir('project');
    process.env.PI_MESSENGER_DIR = custom;
    const channel = ensureSessionChannel(
      dirsFor(path.join(cwd, '.pi', 'messenger')),
      'project-session'
    );

    expect(getProjectChannelSessionId(cwd, channel.id)).toBe('project-session');
  });
});

describe('channel session lookup without overrides', () => {
  it('keeps the project-scoped default behaviour', () => {
    const cwd = tempDir('project');
    const channel = ensureSessionChannel(
      dirsFor(path.join(cwd, '.pi', 'messenger')),
      'local-session'
    );

    expect(getProjectChannelSessionId(cwd, channel.id)).toBe('local-session');
    expect(getEffectiveSessionId(cwd, childState(channel.id))).toBe('local-session');
    expect(getProjectChannelSessionId(cwd, 'missing-channel')).toBeNull();
  });
});
