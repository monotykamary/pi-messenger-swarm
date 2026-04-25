import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as taskStore from '../../swarm/task-store.js';

const roots = new Set<string>();
const TEST_SESSION = 'test-session-statusbar';
const TEST_CHANNEL = 'test-channel';

function createTempCwd(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-statusbar-'));
  roots.add(cwd);
  return cwd;
}

afterAll(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
});

describe('swarm status bar litmus', () => {
  let renderStatusBar: typeof import('../../overlay/render-exports.js').renderStatusBar;

  beforeAll(async () => {
    const mod = await import('../../overlay/render-exports.js');
    renderStatusBar = mod.renderStatusBar;
  });

  it('shows empty-state status when no tasks exist', () => {
    const cwd = createTempCwd();
    const tasks = taskStore.getTasks(cwd, TEST_SESSION);
    const mockTheme = { fg: (_color: string, text: string) => text } as any;
    const line = renderStatusBar(mockTheme, cwd, 120, TEST_CHANNEL, new Map(), tasks, TEST_SESSION);
    expect(line).toContain('No swarm tasks');
  });

  it('shows summary counts when tasks exist', () => {
    const cwd = createTempCwd();

    const t1 = taskStore.createTask(cwd, TEST_SESSION, { title: 'Done' }, TEST_CHANNEL);
    const t2 = taskStore.createTask(cwd, TEST_SESSION, { title: 'In progress' }, TEST_CHANNEL);

    taskStore.claimTask(cwd, TEST_SESSION, t1.id, 'AgentA');
    taskStore.completeTask(cwd, TEST_SESSION, t1.id, 'AgentA', 'done');
    taskStore.claimTask(cwd, TEST_SESSION, t2.id, 'AgentB');

    const tasks = taskStore.getTasks(cwd, TEST_SESSION);
    const line = renderStatusBar({} as any, cwd, 120, TEST_CHANNEL, new Map(), tasks, TEST_SESSION);
    expect(line).toContain('☑ 1/2 tasks');
    expect(line).toContain('ready 0');
    expect(line).toContain('in progress 1');
  });
});
