import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'pi-extension-compat-'));
const previousCwd = process.cwd();
const isolatedEnv = { HOME: home, PI_CODING_AGENT_DIR: home, PI_SWARM_SPAWNED: '1', PI_MESSENGER_DIR: join(home, 'messenger'), PI_MESSENGER_CWD: home, PI_MESSENGER_GLOBAL: undefined };
const previousEnv = Object.fromEntries(Object.keys(isolatedEnv).map(key => [key, process.env[key]]));
const previousFetch = globalThis.fetch;
for (const [key, value] of Object.entries(isolatedEnv)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
process.chdir(home);
globalThis.fetch = async () => new Response('', { status: 503 });
let session;
let shutDown = false;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } = await import('@earendil-works/pi-coding-agent');
  assert.equal(VERSION, '1.1.0', 'test the actual pinned Pi host, not a stale override');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/pi-coding-agent', '@earendil-works/pi-tui', 'typebox']) {
    assert.equal(manifest.dependencies?.[name], undefined, `${name}: host packages must not be runtime dependencies`);
    if (manifest.peerDependencies?.[name] !== undefined) assert.equal(manifest.peerDependencies[name], '*');
  }
  const settingsManager = SettingsManager.inMemory({ packages: [root], compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd: home, agentDir: home, settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const loaded = resourceLoader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  assert.deepEqual(loaded.warnings ?? [], []);
  assert.ok(loaded.extensions.length > 0, 'manifest entrypoints must load');
  const modelRuntime = await ModelRuntime.create({ authPath: join(home, 'auth.json'), modelsPath: null, modelsStorePath: join(home, 'models-cache'), allowModelNetwork: false });
  ({ session } = await createAgentSession({ cwd: home, agentDir: home, resourceLoader, modelRuntime, settingsManager, sessionManager: SessionManager.inMemory(home) }));
  const errors = [];
  await session.bindExtensions({ mode: 'print', onError: error => errors.push(error) });
  await new Promise(done => setImmediate(done));
  const expectedCommand = {
    'pi-autoresearch-harness': 'autoresearch',
    '@monotykamary/pi-computer-use': 'computer-use',
    '@monotykamary/pi-cost-backoff': 'cost-backoff',
    'pi-discord': 'discord',
    '@monotykamary/pi-loop': 'loop',
    'pi-messenger-swarm': 'messenger',
  }[manifest.name];
  assert.ok(expectedCommand && session.extensionRunner.getRegisteredCommands().some(command => command.name === expectedCommand), 'public slash command must be registered');
  const names = new Set();
  for (const extension of loaded.extensions) {
    for (const [name, { definition }] of extension.tools) {
      assert.equal(definition.name, name);
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.parameters, 'object');
      assert.ok(!names.has(name), `duplicate tool ${name}`);
      names.add(name);
      assert.ok(session.getAllTools().some(tool => tool.name === name), `${name}: tool must be installed in the real session`);
    }
  }
  await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  shutDown = true;
  assert.deepEqual(errors, [], 'real Pi 1.1 startup/shutdown must succeed');
  console.log(`${manifest.name}: Pi ${VERSION} warning-free manifest, /${expectedCommand}, headless lifecycle; ${loaded.extensions.length} extensions, ${names.size} tools registered`);
} finally {
  try {
    if (session && !shutDown) await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    session?.dispose();
    globalThis.fetch = previousFetch;
    process.chdir(previousCwd);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
}
