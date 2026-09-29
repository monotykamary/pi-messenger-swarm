import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = await mkdtemp(join(tmpdir(), 'pi-extension-compat-'));
const previousHome = process.env.PI_CODING_AGENT_DIR;
const previousFetch = globalThis.fetch;
process.env.PI_CODING_AGENT_DIR = home;
globalThis.fetch = async () => new Response('', { status: 503 });
let session;
try {
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } = await import('@earendil-works/pi-coding-agent');
  assert.equal(VERSION, '0.99.0', 'test the actual pinned Pi host, not a stale override');
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
  console.log(`${manifest.name}: Pi ${VERSION} warning-free manifest load; ${loaded.extensions.length} extensions, ${names.size} tools registered`);
} finally {
  session?.dispose();
  globalThis.fetch = previousFetch;
  if (previousHome === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousHome;
  await rm(home, { recursive: true, force: true });
}
