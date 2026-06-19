import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import type { AutocompleteProviderFactory } from '@earendil-works/pi-coding-agent';
import type { Dirs, MessengerState } from '../lib.js';
import { collectChannelCandidates } from '../overlay/actions.js';
import { COMMAND_REGISTRY } from '../harness/commands.js';

/**
 * Build CLI command autocomplete items for a given `##<typed>` context.
 *
 * - typed = ''        → top-level commands only (deduplicated first words)
 * - typed = 'task'    → top-level commands starting with 'task'
 * - typed = 'task '   → subcommands starting with 'task '
 * - typed = 'task l'  → subcommands starting with 'task l'
 */
function getCliItems(typed: string, prefix: '##'): AutocompleteItem[] | null {
  if (!typed.includes(' ')) {
    // Show deduplicated top-level commands (first word of each entry)
    const lower = typed.toLowerCase();
    const seen = new Set<string>();
    const result: AutocompleteItem[] = [];
    for (const { cmd, description } of COMMAND_REGISTRY) {
      const top = cmd.split(' ')[0];
      if (lower && !top.toLowerCase().startsWith(lower)) continue;
      if (seen.has(top)) continue;
      seen.add(top);
      const directCmd = COMMAND_REGISTRY.find((c) => c.cmd === top);
      const desc = directCmd?.description ?? `${top} subcommands`;
      result.push({
        value: `${prefix}${top} `,
        label: `${prefix}${top}`,
        description: desc,
      });
    }
    return result.length > 0 ? result : null;
  }

  // typed contains a space → filter full compound commands
  const lower = typed.toLowerCase();
  const matched = COMMAND_REGISTRY.filter(({ cmd }) => cmd.toLowerCase().startsWith(lower));
  if (matched.length === 0) return null;
  return matched.map(({ cmd, description }) => ({
    value: `${prefix}${cmd} `,
    label: `${prefix}${cmd}`,
    description,
  }));
}

/**
 * Returns true when the text before cursor is in the message-body of a
 * `#mention <message>` input — i.e. a complete `#word` followed by at least
 * one space.  Used to suppress irrelevant autocomplete (file completions) in
 * that region.
 *
 * Examples that match:  '#swift-phoenix '   '#all hello '
 * Examples that don't:  '#swift-phoenix'    '##task '    'hello #swift-phoenix'
 */
function isMentionMessageBody(textBeforeCursor: string): boolean {
  // Must start with (or be preceded by whitespace and) a `#word` (at least one
  // alphanumeric char after #) followed by one or more spaces.  The `##` case
  // is excluded because the doubleMatch branch handles it first.
  return (
    /(?:^|[ \t])#[A-Za-z0-9][A-Za-z0-9_-]*[ \t]/.test(textBeforeCursor) &&
    !/(?:^|[ \t])##/.test(textBeforeCursor)
  );
}

/**
 * Autocomplete provider factory for `##cmd` and `#mention` completions.
 *
 * Three separate branches (checked in order):
 *
 *   `##<typed>` — CLI command completions.
 *     Triggers automatically when the user types `##` (the second `#` narrows
 *     from the mention branch into the command branch).
 *     Uses regex /(?:^|[ \t])##(.*)$/ which matches even when typed contains
 *     spaces (e.g. `##task `) so sub-commands are reachable via Tab.
 *
 *   `#<typed>` — Agent / channel mentions (triggered on first `#`).
 *     Shows agents and `#all`.
 *
 *   `#mention <message body>` — once a complete mention is followed by a
 *     space the mention branch exits, but we suppress the default (file)
 *     autocomplete so the chat message body stays clean.
 */
export function createMentionAutocompleteProvider(
  state: MessengerState,
  dirs: Dirs
): AutocompleteProviderFactory {
  return (current: AutocompleteProvider): AutocompleteProvider => ({
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const line = lines[cursorLine] ?? '';
      const textBeforeCursor = line.slice(0, cursorCol);

      // ── ## branch (CLI commands) ──────────────────────────────────────────
      // Must be checked before # branch because '##task' also matches #(\S*)$.
      const doubleMatch = textBeforeCursor.match(/(?:^|[ \t])##(.*)$/);
      if (doubleMatch) {
        const typed = doubleMatch[1] ?? '';
        const items = getCliItems(typed, '##');
        if (!items || items.length === 0) return null;
        return { items, prefix: `##${typed}` };
      }

      // ── # branch (agents / channel mentions) ─────────────────────────────
      const singleMatch = textBeforeCursor.match(/(?:^|[ \t])#(\S*)$/);
      if (!singleMatch) {
        if (isMentionMessageBody(textBeforeCursor)) return null;
        return current.getSuggestions(lines, cursorLine, cursorCol, options);
      }

      const typed = singleMatch[1] ?? '';
      const candidates = collectChannelCandidates(typed, state, dirs, process.cwd());

      const items: AutocompleteItem[] = candidates.map((ch) => ({
        value: `#${ch} `,
        label: `#${ch}`,
        description: ch === 'all' ? 'Broadcast to all agents' : 'Send to agent',
      }));

      // On bare `#` (nothing typed yet) add `##` as a gateway so users can
      // discover CLI command mode without needing to know the prefix.
      if (!typed) {
        items.push({
          value: '##',
          label: '##',
          description: 'Run a swarm CLI command',
        });
      }

      if (items.length === 0) return null;

      return { items, prefix: `#${typed}` };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (prefix.startsWith('#')) {
        const line = lines[cursorLine] ?? '';
        const before = line.slice(0, cursorCol - prefix.length);
        const after = line.slice(cursorCol);
        const newLine = before + item.value + after;
        const newLines = [...lines];
        newLines[cursorLine] = newLine;
        return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
      }
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const line = lines[cursorLine] ?? '';
      const textBeforeCursor = line.slice(0, cursorCol);
      // ## context: always allow Tab (even with spaces like '##task ')
      if (/(^|[ \t])##/.test(textBeforeCursor)) return true;
      // # mention context (no ## prefix): suppress file completion
      if (/(^|[ \t])#\S*$/.test(textBeforeCursor)) return false;
      // Message body after a #mention: suppress file completion
      if (isMentionMessageBody(textBeforeCursor)) return false;
      return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
    },
  });
}
