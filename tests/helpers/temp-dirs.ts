import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

const roots = new Set<string>();

export interface TempMessengerDirs {
  root: string;
  cwd: string;
  swarmDir: string;
  tasksDir: string;
  blocksDir: string;
}

export function createTempMessengerDirs(): TempMessengerDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-test-"));
  roots.add(root);

  const cwd = root;
  const messengerDir = path.join(cwd, ".pi", "messenger");
  const swarmDir = path.join(messengerDir, "swarm");
  const tasksDir = path.join(swarmDir, "tasks");
  const blocksDir = path.join(swarmDir, "blocks");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(blocksDir, { recursive: true });

  return { root, cwd, swarmDir, tasksDir, blocksDir };
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});
