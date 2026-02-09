import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "vitest";

const roots = new Set<string>();

export interface TempCrewDirs {
  root: string;
  cwd: string;
  crewDir: string;
  tasksDir: string;
  blocksDir: string;
}

export function createTempCrewDirs(): TempCrewDirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-messenger-test-"));
  roots.add(root);

  const cwd = root;
  const messengerDir = path.join(cwd, ".pi", "messenger");
  const crewDir = path.join(messengerDir, "crew");
  const tasksDir = path.join(crewDir, "tasks");
  const blocksDir = path.join(crewDir, "blocks");

  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(blocksDir, { recursive: true });

  return { root, cwd, crewDir, tasksDir, blocksDir };
}

afterEach(() => {
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  roots.clear();
});
