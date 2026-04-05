import * as fs from 'node:fs';
import * as path from 'node:path';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getTasksJsonlPath(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'tasks', `${safeSessionId}.jsonl`);
}

export function getTaskSpecsDir(cwd: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^\w.-]/g, '_');
  return path.join(cwd, '.pi', 'messenger', 'tasks', safeSessionId);
}

export function taskSpecPath(cwd: string, sessionId: string, taskId: string): string {
  return path.join(getTaskSpecsDir(cwd, sessionId), `${taskId}.md`);
}

export function writeTaskSpec(
  cwd: string,
  sessionId: string,
  taskId: string,
  title: string,
  content?: string
): void {
  const specPath = taskSpecPath(cwd, sessionId, taskId);
  ensureDir(path.dirname(specPath));
  fs.writeFileSync(
    specPath,
    content?.trim() ? `# ${title}\n\n${content.trim()}\n` : `# ${title}\n\n*Spec pending*\n`,
    'utf-8'
  );
}

export function readTaskSpec(cwd: string, sessionId: string, taskId: string): string | null {
  const specPath = taskSpecPath(cwd, sessionId, taskId);
  if (!fs.existsSync(specPath)) return null;
  try {
    return fs.readFileSync(specPath, 'utf-8');
  } catch {
    return null;
  }
}

export function deleteTaskSpec(cwd: string, sessionId: string, taskId: string): void {
  try {
    fs.unlinkSync(taskSpecPath(cwd, sessionId, taskId));
  } catch {
    // Ignore errors
  }
}

export { ensureDir };
