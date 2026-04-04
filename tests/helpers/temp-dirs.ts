import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach } from 'vitest';

const roots = new Set<string>();

export interface TempMessengerDirs {
  root: string;
  cwd: string;
  messengerDir: string;
  registryDir: string;
  channelsDir: string;
  tasksDir: string;
}

export function createTempMessengerDirs(): TempMessengerDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-messenger-test-'));
  roots.add(root);

  const cwd = root;
  const messengerDir = path.join(cwd, '.pi', 'messenger');
  const registryDir = path.join(messengerDir, 'registry');
  const channelsDir = path.join(messengerDir, 'channels');
  const tasksDir = path.join(messengerDir, 'tasks');

  fs.mkdirSync(registryDir, { recursive: true });
  fs.mkdirSync(channelsDir, { recursive: true });
  fs.mkdirSync(tasksDir, { recursive: true });

  return { root, cwd, messengerDir, registryDir, channelsDir, tasksDir };
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});
