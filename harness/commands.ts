/**
 * Canonical command registry for pi-messenger-swarm.
 *
 * Single source of truth for:
 *  - Autocomplete (extension/mention-autocomplete.ts imports COMMAND_REGISTRY)
 *  - Smart arg parsing (splitCliArgs uses the schema)
 *  - Future direct invocation (remove harness/cli.ts dependency)
 *
 * `cmd`    — space-separated CLI form: "task done"
 * `action` — router dot-form: "task.done"
 * `args`   — positional schema:
 *              'word'  = one whitespace-delimited token
 *              'rest+' = all remaining tokens joined with a space
 * `flags`  — long-flag names accepted (without --)
 */

export interface CommandSpec {
  cmd: string;
  action: string;
  description: string;
  args?: string[];
  flags?: string[];
}

export const COMMAND_REGISTRY: CommandSpec[] = [
  // ── Coordination ──────────────────────────────────────────────────────────
  {
    cmd: 'join',
    action: 'join',
    description: 'Join the agent mesh',
    flags: ['channel', 'create'],
  },
  {
    cmd: 'status',
    action: 'status',
    description: 'Show agent status',
  },
  {
    cmd: 'list',
    action: 'list',
    description: 'List active agents',
  },
  {
    cmd: 'whois',
    action: 'whois',
    description: 'Get agent details',
    args: ['name'],
  },
  {
    cmd: 'feed',
    action: 'feed',
    description: 'View activity feed',
    flags: ['limit', 'channel'],
  },
  {
    cmd: 'send',
    action: 'send',
    description: 'Send message to agent or channel',
    args: ['to', 'message+'],
  },
  {
    cmd: 'channels',
    action: 'channels',
    description: 'List channels',
    flags: ['all'],
  },
  {
    cmd: 'swarm',
    action: 'swarm',
    description: 'Open swarm board view',
    flags: ['channel'],
  },
  {
    cmd: 'reserve',
    action: 'reserve',
    description: 'Reserve file paths',
    args: ['paths+'],
    flags: ['reason'],
  },
  {
    cmd: 'release',
    action: 'release',
    description: 'Release reservations',
  },
  {
    cmd: 'set-status',
    action: 'set_status',
    description: 'Set custom status message',
    args: ['message+'],
  },
  {
    cmd: 'rename',
    action: 'rename',
    description: 'Rename this agent',
    args: ['name'],
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  {
    cmd: 'task list',
    action: 'task.list',
    description: 'List all tasks',
  },
  {
    cmd: 'task ready',
    action: 'task.ready',
    description: 'List ready tasks',
  },
  {
    cmd: 'task stalled',
    action: 'task.stalled',
    description: 'List tasks with no recent progress',
  },
  {
    cmd: 'task show',
    action: 'task.show',
    description: 'Show task details',
    args: ['id'],
  },
  {
    cmd: 'task create',
    action: 'task.create',
    description: 'Create a new task',
    flags: ['title', 'content', 'depends-on'],
  },
  {
    cmd: 'task claim',
    action: 'task.claim',
    description: 'Claim a task',
    args: ['id'],
  },
  {
    cmd: 'task unclaim',
    action: 'task.unclaim',
    description: 'Unclaim a task',
    args: ['id'],
  },
  {
    cmd: 'task progress',
    action: 'task.progress',
    description: 'Log task progress',
    args: ['id', 'message+'],
  },
  {
    cmd: 'task done',
    action: 'task.done',
    description: 'Mark task as done',
    args: ['id', 'summary+'],
  },
  {
    cmd: 'task block',
    action: 'task.block',
    description: 'Block a task',
    args: ['id'],
    flags: ['reason'],
  },
  {
    cmd: 'task unblock',
    action: 'task.unblock',
    description: 'Unblock a task',
    args: ['id'],
  },
  {
    cmd: 'task reset',
    action: 'task.reset',
    description: 'Reset a task',
    args: ['id'],
    flags: ['cascade'],
  },
  {
    cmd: 'task archive-done',
    action: 'task.archive_done',
    description: 'Archive completed tasks',
  },

  // ── Spawn ─────────────────────────────────────────────────────────────────
  {
    cmd: 'spawn',
    action: 'spawn',
    description: 'Spawn a subagent',
    args: ['message+'],
    flags: [
      'role',
      'persona',
      'task-id',
      'name',
      'agent-file',
      'objective',
      'context',
      'message-file',
      'force',
    ],
  },
  {
    cmd: 'spawn list',
    action: 'spawn.list',
    description: 'List spawned agents',
  },
  {
    cmd: 'spawn history',
    action: 'spawn.history',
    description: 'Show spawn history',
  },
  {
    cmd: 'spawn stop',
    action: 'spawn.stop',
    description: 'Stop a spawned agent',
    args: ['id'],
  },
];

/**
 * Find the CommandSpec that best matches the typed CLI text.
 * Prefers longer (more specific) matches: "task done" wins over "task".
 */
export function findCommandSpec(text: string): CommandSpec | undefined {
  const lower = text.toLowerCase();
  let best: CommandSpec | undefined;
  for (const spec of COMMAND_REGISTRY) {
    if (lower === spec.cmd || lower.startsWith(spec.cmd + ' ')) {
      if (!best || spec.cmd.length > best.cmd.length) {
        best = spec;
      }
    }
  }
  return best;
}

/**
 * Split a raw CLI string into an args array using the command schema.
 *
 * Without a matching spec the string is split naively on whitespace.
 * With a spec, positional args marked with `+` (e.g. 'message+') cause
 * all remaining tokens to be joined back into a single string, which
 * preserves multi-word values without requiring shell quoting.
 *
 * Flags (--flag value) are passed through as individual tokens and may appear
 * before or after positional args — the CLI's extractFlag() handles them
 * positionally-agnostic.  Commands with no rest+ arg (e.g. task block) fall
 * back to naive splitting, so flags and positionals work in any order.
 *
 * Note: for `task block`, the CLI also accepts bare reason text after the id
 * without --reason: `task block task-1 awaiting review` is equivalent to
 * `task block task-1 --reason "awaiting review"`.  No shell quoting needed
 * when using the ##cmd shorthand since input bypasses the shell entirely.
 *
 * Examples (spec args: ['id', 'summary+']):
 *   "task done task-1 my summary text" → ["task","done","task-1","my summary text"]
 *   "task done task-1"                 → ["task","done","task-1"]
 */
export function splitCliArgs(rest: string): string[] {
  const spec = findCommandSpec(rest);
  if (!spec || !spec.args || !spec.args.some((a) => a.endsWith('+'))) {
    return rest.split(/\s+/).filter(Boolean);
  }

  // Split everything first
  const tokens = rest.split(/\s+/).filter(Boolean);
  const cmdWords = spec.cmd.split(' ');
  let i = cmdWords.length; // index into tokens after the command prefix

  const result: string[] = [...cmdWords];

  for (let ai = 0; ai < spec.args.length; ai++) {
    const argSpec = spec.args[ai];
    const isRest = argSpec.endsWith('+');

    if (i >= tokens.length) break;

    // Skip flag tokens (--flag and its value)
    while (i < tokens.length && tokens[i].startsWith('--')) {
      result.push(tokens[i]); // --flag
      i++;
      if (i < tokens.length && !tokens[i].startsWith('--')) {
        result.push(tokens[i]); // value
        i++;
      }
    }

    if (i >= tokens.length) break;

    if (isRest) {
      // Join all remaining non-exhausted tokens (excluding trailing flags)
      const flagStart = tokens.slice(i).findIndex((t) => t.startsWith('--'));
      const restTokens = flagStart === -1 ? tokens.slice(i) : tokens.slice(i, i + flagStart);
      const trailingFlags = flagStart === -1 ? [] : tokens.slice(i + flagStart);
      if (restTokens.length > 0) {
        result.push(restTokens.join(' '));
      }
      result.push(...trailingFlags);
      i = tokens.length;
    } else {
      result.push(tokens[i]);
      i++;
    }
  }

  // Pass through any remaining tokens (shouldn't normally happen)
  if (i < tokens.length) {
    result.push(...tokens.slice(i));
  }

  return result;
}
