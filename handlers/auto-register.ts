import { getAutoRegisterPaths, matchesAutoRegisterPath, saveAutoRegisterPaths } from '../config.js';
import { result } from './result.js';

export function executeAutoRegisterPath(action: 'add' | 'remove' | 'list') {
  const cwd = process.cwd();
  const paths = getAutoRegisterPaths();

  if (action === 'list') {
    if (paths.length === 0) {
      return result(
        'No auto-register paths configured.\n\nUse pi_messenger({ action: "autoRegisterPath", autoRegisterPath: "add" }) to add the current folder.',
        {
          mode: 'autoRegisterPath',
          action: 'list',
          paths: [],
          currentFolder: cwd,
          isCurrentInList: false,
        }
      );
    }

    const isCurrentInList = matchesAutoRegisterPath(cwd, paths);
    const lines = ['Auto-register paths:', ''];
    for (const p of paths) {
      const marker = p === cwd ? ' (current)' : '';
      lines.push(`  ${p}${marker}`);
    }
    lines.push('');
    lines.push(`Current folder: ${cwd}`);
    lines.push(
      `Status: ${isCurrentInList ? 'Will auto-register here' : 'Will NOT auto-register here'}`
    );

    return result(lines.join('\n'), {
      mode: 'autoRegisterPath',
      action: 'list',
      paths,
      currentFolder: cwd,
      isCurrentInList,
    });
  }

  if (action === 'add') {
    if (paths.includes(cwd)) {
      return result(`Current folder already in auto-register paths:\n  ${cwd}`, {
        mode: 'autoRegisterPath',
        action: 'add',
        alreadyExists: true,
        path: cwd,
      });
    }

    const newPaths = [...paths, cwd];
    saveAutoRegisterPaths(newPaths);

    return result(
      `Added to auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will now auto-join the mesh.`,
      {
        mode: 'autoRegisterPath',
        action: 'add',
        path: cwd,
        paths: newPaths,
      }
    );
  }

  if (action === 'remove') {
    if (!paths.includes(cwd)) {
      const isMatched = matchesAutoRegisterPath(cwd, paths);
      if (isMatched) {
        return result(
          "Current folder matches a glob pattern but isn't an exact entry.\nManually edit ~/.pi/agent/pi-messenger.json to modify glob patterns.",
          { mode: 'autoRegisterPath', action: 'remove', notExact: true, path: cwd }
        );
      }
      return result(`Current folder not in auto-register paths:\n  ${cwd}`, {
        mode: 'autoRegisterPath',
        action: 'remove',
        notFound: true,
        path: cwd,
      });
    }

    const newPaths = paths.filter((p) => p !== cwd);
    saveAutoRegisterPaths(newPaths);

    return result(
      `Removed from auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will no longer auto-join.`,
      {
        mode: 'autoRegisterPath',
        action: 'remove',
        path: cwd,
        paths: newPaths,
      }
    );
  }

  return result('Invalid action. Use: add, remove, or list', {
    mode: 'autoRegisterPath',
    error: 'invalid_action',
  });
}
