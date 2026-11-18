import {
  getAutoRegisterPaths,
  matchesAutoRegisterPath,
  mutateAutoRegisterPaths,
} from '../config.js';
import { result } from './result.js';

export function executeAutoRegisterPath(action: 'add' | 'remove' | 'list') {
  const cwd = process.cwd();
  if (action === 'list') {
    const paths = getAutoRegisterPaths();
    if (paths.length === 0) {
      return result(
        'No auto-register paths configured.\n\nUse `pi-messenger-swarm autoRegisterPath add` to add the current folder.',
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

  if (action === 'add' || action === 'remove') {
    try {
      return mutateAutoRegisterPaths((paths) => {
        if (action === 'add') {
          if (paths.includes(cwd)) {
            return result(`Current folder already in auto-register paths:\n  ${cwd}`, {
              mode: 'autoRegisterPath',
              action: 'add',
              alreadyExists: true,
              path: cwd,
            });
          }

          paths.push(cwd);

          return result(
            `Added to auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will now auto-join the mesh.`,
            {
              mode: 'autoRegisterPath',
              action: 'add',
              path: cwd,
              paths,
            }
          );
        }

        if (!paths.includes(cwd)) {
          if (matchesAutoRegisterPath(cwd, paths)) {
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

        paths.splice(0, paths.length, ...paths.filter((p) => p !== cwd));
        return result(
          `Removed from auto-register paths:\n  ${cwd}\n\nAgents starting in this folder will no longer auto-join.`,
          { mode: 'autoRegisterPath', action: 'remove', path: cwd, paths }
        );
      });
    } catch (error) {
      return result(`Could not update auto-register paths: ${String(error)}`, {
        mode: 'autoRegisterPath',
        action,
        error: 'config_write_failed',
      });
    }
  }

  return result('Invalid action. Use: add, remove, or list', {
    mode: 'autoRegisterPath',
    error: 'invalid_action',
  });
}
