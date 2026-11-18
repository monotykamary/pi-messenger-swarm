import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// Follow leaf symlinks as writeFile/appendFile do, rather than replacing the
// link itself. Canonicalize the parent as well so directory aliases agree.
function resolveWritePath(path: string): string {
  for (let links = 0; links < 40; links++) {
    const parent = fs.realpathSync.native(dirname(path));
    const candidate = join(parent, basename(path));
    try {
      if (!fs.lstatSync(candidate).isSymbolicLink()) return candidate;
      path = resolve(parent, fs.readlinkSync(candidate));
    } catch (error) {
      if (isMissing(error)) return candidate;
      throw error;
    }
  }
  throw new Error(`Too many symlinks: ${path}`);
}

export function atomicWriteFileSync(path: string, data: string): void {
  const target = resolveWritePath(path);
  const existing = fs.statSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isFile()) throw new Error(`Not a regular file: ${target}`);
  const temp = join(dirname(target), `.pi-messenger-${randomUUID()}.tmp`);
  // Open outside the cleanup scope: on EEXIST the temp belongs to someone else.
  const fd = fs.openSync(temp, 'wx', existing ? 0o600 : 0o666);
  let published = false;
  try {
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      if (existing) fs.fchmodSync(fd, existing.mode & 0o777);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, target);
    published = true;
  } finally {
    if (!published) fs.rmSync(temp, { force: true });
  }
}

export function readTextIfPresent(path: string): string | undefined {
  try {
    return fs.readFileSync(path, 'utf-8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export function readJsonObjectSync(path: string): Record<string, unknown> | undefined {
  const text = readTextIfPresent(path);
  if (text === undefined) return undefined;
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected a JSON object: ${path}`);
  }
  return value as Record<string, unknown>;
}

const sleepWord = new Int32Array(new SharedArrayBuffer(4));

/**
 * Local-filesystem advisory lock for synchronous transactions. Never steal a
 * lock: a paused writer can always resume, and unlink/recreate is not CAS.
 * An unclean exit can leave the lock behind. Remove it only with all writers
 * stopped. The PID is diagnostic, not evidence that it is safe to steal.
 */
export function withFileLock<T>(path: string, operation: () => T, timeoutMs = 5000): T {
  const lockPath = `${resolveWritePath(path)}.lock`;
  const deadline = performance.now() + timeoutMs;
  let fd: number;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for writer lock: ${lockPath}`);
      Atomics.wait(sleepWord, 0, 0, Math.min(10, remaining));
    }
  }
  try {
    try {
      fs.writeFileSync(fd, `${process.pid}\n`);
    } finally {
      fs.closeSync(fd);
    }
    return operation();
  } finally {
    fs.unlinkSync(lockPath);
  }
}
