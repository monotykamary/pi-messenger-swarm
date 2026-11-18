import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  appendChannelEventLine,
  channelPath,
  getChannelsDir,
  patchChannelSessionId,
  pruneChannelEvents,
  readChannelEventLines,
  readChannelHeader,
  writeChannel,
} from '../channel.js';
import { atomicWriteFileSync, withFileLock } from '../persistence.js';
import {
  flushActivityToRegistry,
  patchRegistrationSessionId,
  register,
  renameAgent,
  unregister,
} from '../store.js';
import {
  createContext,
  createMessengerFixture,
  createState,
} from './helpers/messenger-fixtures.js';

// Use the same production code in independent Node processes, without requiring
// a prebuilt dist or importing Vitest workers into the child processes.
const worker = String.raw`
import fs from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { isAbsolute } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' ||
        !specifier.endsWith('.js') || !(specifier.startsWith('.') || isAbsolute(specifier))) throw error;
    return next(specifier.slice(0, -3) + '.ts', context);
  }
} });
const job = JSON.parse(process.argv[1]);
const { atomicWriteFileSync, withFileLock } = await import('./persistence.ts');
if (job.op === 'hold') {
  withFileLock(job.lock, () => {
    process.send('holding');
    const sleepWord = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 9000;
    while (!fs.existsSync(job.release)) {
      if (performance.now() >= deadline) throw new Error('No release signal');
      Atomics.wait(sleepWord, 0, 0, 5);
    }
    if (job.target) atomicWriteFileSync(job.target, job.data);
  });
} else {
  // Signal an actual failed exclusive open, not a timing guess about when
  // the other process might have entered its read/modify/write operation.
  const open = fs.openSync;
  let blocked = false;
  fs.openSync = (...args) => {
    try { return open(...args); }
    catch (error) {
      if (!blocked && error.code === 'EEXIST' && args[1] === 'wx' && String(args[0]).endsWith('.lock')) {
        blocked = true;
        process.send('blocked');
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  if (job.op === 'config') {
    const { mutateAutoRegisterPaths } = await import('./config.ts');
    mutateAutoRegisterPaths((paths) => paths.push('/mine'));
  } else if (job.op === 'join') {
    const { joinChannel } = await import('./store/registration.ts');
    const result = joinChannel(job.state, job.dirs, 'mine', { create: true });
    if (!result.success) throw new Error(JSON.stringify(result));
  } else {
    const channel = await import('./channel.ts');
    if (job.op === 'append') channel.appendChannelEventLine(job.dirs, 'shared', job.data);
    if (job.op === 'prune') channel.pruneChannelEvents(job.dirs, 'shared', 1);
    if (job.op === 'rewrite') channel.writeChannel(job.dirs, job.record);
    if (job.op === 'patch' && channel.patchChannelSessionId(job.dirs, 'shared', 'too-late')) {
      throw new Error('Overwrote the first session ID');
    }
  }
}
process.disconnect();
`;

function start(job: object, agentDir?: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', worker, JSON.stringify(job)],
    {
      env: { ...process.env, ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}) },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      timeout: 12000,
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const firstMessage = new Promise<unknown>((resolve) => {
    child.once('message', resolve);
    child.once('close', () => resolve(undefined));
  });
  const done = new Promise<string | undefined>((resolve) => {
    child.once('error', (error) => resolve(String(error)));
    child.once('close', (code, signal) =>
      resolve(code === 0 ? undefined : `${code ?? signal}: ${stderr}`)
    );
  });
  return { firstMessage, done };
}

async function interleave(
  hold: { lock: string; release: string; target?: string; data?: string },
  jobs: object[],
  agentDir?: string
) {
  const holder = start({ op: 'hold', ...hold });
  const others: ReturnType<typeof start>[] = [];
  try {
    expect(await holder.firstMessage, 'writer never acquired the lock').toBe('holding');
    for (const job of jobs) others.push(start(job, agentDir));
    for (const other of others) {
      expect(
        await other.firstMessage,
        'writer never reached an actual competing exclusive open'
      ).toBe('blocked');
    }
  } finally {
    fs.writeFileSync(hold.release, '');
    expect(await Promise.all([holder.done, ...others.map((other) => other.done)])).toEqual(
      [holder, ...others].map(() => undefined)
    );
  }
}

const record = { id: 'shared', type: 'named' as const, createdAt: '2026-01-01T00:00:00Z' };
const header = JSON.stringify({ _meta: true, v: 1, ...record });
const log = (...events: string[]) => [header, ...events, ''].join('\n');
const event = (n: number) => JSON.stringify({ n });

it('publishes one header and both first appends from contending processes', async () => {
  const { cwd, dirs } = createMessengerFixture();
  const dir = getChannelsDir(dirs);
  fs.mkdirSync(dir);
  await interleave({ lock: join(dir, '.channels'), release: join(cwd, 'release') }, [
    { op: 'append', dirs, data: event(1) },
    { op: 'append', dirs, data: event(2) },
  ]);
  expect(readChannelHeader(dirs, 'shared')?.id).toBe('shared');
  expect(readChannelEventLines(dirs, 'shared').sort()).toEqual([event(1), event(2)]);
});

it.each(['prune', 'rewrite', 'patch'])('uses the post-lock snapshot for channel %s', async (op) => {
  const { cwd, dirs } = createMessengerFixture();
  const file = channelPath(dirs, 'shared');
  writeChannel(dirs, record);
  appendChannelEventLine(dirs, 'shared', event(1));
  const latest =
    op === 'patch'
      ? log(event(1), event(2)).replace('"id":', '"sessionId":"first","id":')
      : log(event(1), event(2));
  await interleave(
    {
      lock: join(getChannelsDir(dirs), '.channels'),
      release: join(cwd, 'release'),
      target: file,
      data: latest,
    },
    [{ op, dirs, record: { ...record, description: 'new metadata' } }]
  );
  expect(readChannelEventLines(dirs, 'shared')).toEqual(
    op === 'prune' ? [event(2)] : [event(1), event(2)]
  );
  if (op === 'patch') expect(readChannelHeader(dirs, 'shared')?.sessionId).toBe('first');
  if (op === 'rewrite') expect(readChannelHeader(dirs, 'shared')?.description).toBe('new metadata');
});

it('never steals an old lock or touches the owner’s lock file on timeout', () => {
  const { cwd } = createMessengerFixture();
  const target = join(cwd, 'state.json');
  const lock = `${target}.lock`;
  fs.writeFileSync(lock, 'old owner');
  fs.utimesSync(lock, 1, 1);
  expect(() =>
    withFileLock(
      target,
      () => {
        throw new Error('stole the lock');
      },
      15
    )
  ).toThrow('Timed out');
  expect(fs.readFileSync(lock, 'utf-8')).toBe('old owner');
});

it('preserves JSONL when the existing last line has no newline, then prunes to zero', () => {
  const { dirs } = createMessengerFixture();
  writeChannel(dirs, record);
  fs.writeFileSync(channelPath(dirs, 'shared'), `${header}\n${event(1)}`);
  appendChannelEventLine(dirs, 'shared', event(2));
  expect(readChannelEventLines(dirs, 'shared')).toEqual([event(1), event(2)]);
  pruneChannelEvents(dirs, 'shared', 0);
  expect(fs.readFileSync(channelPath(dirs, 'shared'), 'utf-8')).toBe(`${header}\n`);
});

it('leaves malformed channel snapshots untouched instead of rewriting or pruning away history', () => {
  const { dirs } = createMessengerFixture();
  writeChannel(dirs, record);
  const file = channelPath(dirs, 'shared');
  for (const malformed of ['{not JSON\n', log('{not JSON', event(2))]) {
    fs.writeFileSync(file, malformed);
    expect(() => writeChannel(dirs, { ...record, description: 'new' })).toThrow();
    expect(patchChannelSessionId(dirs, 'shared', 'session')).toBe(false);
    pruneChannelEvents(dirs, 'shared', 1);
    expect(fs.readFileSync(file, 'utf-8')).toBe(malformed);
  }
});

it('merges another process’s config edit, preserving unrelated fields, mode and symlink', async () => {
  const { cwd } = createMessengerFixture();
  const config = join(cwd, 'pi-messenger.json');
  const actual = join(cwd, 'data.json');
  fs.writeFileSync(actual, '{}', { mode: 0o640 });
  fs.symlinkSync('data.json', config);
  await interleave(
    {
      lock: actual,
      release: join(cwd, 'release'),
      target: actual,
      data: JSON.stringify({ autoRegisterPaths: ['/other'], scopeToFolder: false }),
    },
    [{ op: 'config' }],
    cwd
  );
  expect(JSON.parse(fs.readFileSync(config, 'utf-8'))).toEqual({
    autoRegisterPaths: ['/other', '/mine'],
    scopeToFolder: false,
  });
  expect(fs.readlinkSync(config)).toBe('data.json');
  expect(fs.statSync(actual).mode & 0o777).toBe(0o640);
  fs.writeFileSync(actual, '[]');
  const invalid = start({ op: 'config' }, cwd);
  expect(await invalid.done).toContain('Expected a JSON object');
  expect(fs.readFileSync(actual, 'utf-8')).toBe('[]');
});

it('merges competing registration routing writes and does not revert them during an activity flush', async () => {
  const { cwd, dirs } = createMessengerFixture();
  const state = createState();
  const ctx = createContext(cwd, '');
  expect(register(state, dirs, ctx)).toBe(true);
  const path = join(dirs.registry, `${state.agentName}.json`);
  const before = JSON.parse(fs.readFileSync(path, 'utf-8'));
  await interleave(
    {
      lock: join(dirs.registry, '.registry'),
      release: join(cwd, 'release'),
      target: path,
      data: JSON.stringify({
        ...before,
        joinedChannels: [...before.joinedChannels, 'other'],
        sessionId: 'from-harness',
      }),
    },
    [{ op: 'join', dirs, state: { ...state, callerPid: process.pid } }]
  );
  expect(patchRegistrationSessionId(state, dirs, 'must-not-replace')).toBe(true);
  flushActivityToRegistry(state, dirs, ctx);
  expect(JSON.parse(fs.readFileSync(path, 'utf-8'))).toMatchObject({
    currentChannel: 'mine',
    joinedChannels: expect.arrayContaining(['other', 'mine']),
    sessionId: 'from-harness',
  });
});

it('does not clear replacements or malformed registrations during rename, patch or unregister', () => {
  const { cwd, dirs } = createMessengerFixture();
  const state = createState();
  const ctx = createContext(cwd);
  expect(register(state, dirs, ctx)).toBe(true);
  const file = join(dirs.registry, `${state.agentName}.json`);
  const old = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const replacement = { ...old, startedAt: 'replacement', sessionId: '' };
  atomicWriteFileSync(file, JSON.stringify(replacement));
  expect(patchRegistrationSessionId(state, dirs, 'not-mine')).toBe(false);
  expect(renameAgent(state, dirs, ctx, 'Moved', () => {})).toMatchObject({ success: false });
  expect(fs.existsSync(join(dirs.registry, 'Moved.json'))).toBe(false);
  unregister(state, dirs);
  expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual(replacement);
  fs.writeFileSync(file, 'invalid');
  expect(register(createState(), dirs, ctx)).toBe(false);
  expect(fs.readFileSync(file, 'utf-8')).toBe('invalid');
});
