---
name: pi-messenger-swarm
description: Multi-agent coordination and task orchestration. Run actions via the `pi-messenger-swarm` CLI — a persistent harness server handles all state. Use for swarm coordination, task management, agent messaging, and subagent spawning.
---

# Pi-Messenger Swarm Skill

Multi-agent coordination via the `pi-messenger-swarm` CLI.

The CLI auto-spawns a long-lived HTTP server (the **harness**) on first use. Every call dispatches an action to the harness, which holds persistent state — agent registrations, task store, feed — across calls.

- No fixed planner/worker/reviewer roles
- Any joined or spawned agent can create/claim/complete tasks
- When you spawn agents for tasks, act as coordinator — delegate, don't hoard

## Setup

If installed globally (`npm install -g pi-messenger-swarm`), the `pi-messenger-swarm` command is on your PATH. Otherwise, the extension installs a shell wrapper script at `~/.pi/agent/bin/pi-messenger-swarm` which pi adds to PATH automatically — no manual setup needed.

Agent identity is resolved by the CLI using the `PI_AGENT_NAME` environment variable (set by the parent on spawn). The CLI sends this to the harness server, which matches it against registrations on disk. If `PI_AGENT_NAME` is not set (e.g., human terminal), the CLI falls back to walking the process tree to find the parent `pi` process PID.

```
pi-messenger-swarm join
pi-messenger-swarm task list
pi-messenger-swarm swarm
```

## Core protocol

1. Join first

```bash
pi-messenger-swarm join
```

2. Inspect swarm state

```bash
pi-messenger-swarm swarm
pi-messenger-swarm task list
```

3. Delegate before claiming

If you spawned subagents for specific tasks, **do not claim those tasks yourself** — your spawned agents will claim and execute them. Only claim tasks you intend to implement personally (typically tasks you did not delegate).

```bash
# Delegate to a spawned agent
pi-messenger-swarm spawn --task-id task-1 --role Debugger "Fix the race condition"
# Do NOT also: pi-messenger-swarm task claim task-1
```

4. Claim only tasks you will implement yourself

```bash
pi-messenger-swarm task claim task-1
```

5. Reserve files before edits

```bash
pi-messenger-swarm reserve src/auth/ --reason task-1
```

6. Log progress and complete

```bash
pi-messenger-swarm task progress task-1 "Implemented JWT verification"
pi-messenger-swarm task done task-1 "Auth middleware + tests"
pi-messenger-swarm release
```

## Command reference

### Coordination

```bash
pi-messenger-swarm join [--channel dev] [--create]
pi-messenger-swarm status
pi-messenger-swarm list
pi-messenger-swarm channels [--all]
pi-messenger-swarm feed [--limit 20] [--channel dev]
pi-messenger-swarm send AgentName "hello"
pi-messenger-swarm send #memory "remember this"
pi-messenger-swarm reserve src/ --reason task-1
pi-messenger-swarm release
pi-messenger-swarm whois AgentName
pi-messenger-swarm set-status "debugging auth"
pi-messenger-swarm rename NewName
```

### Swarm board

```bash
pi-messenger-swarm swarm [--channel dev]
```

### Task operations

```bash
pi-messenger-swarm task list
pi-messenger-swarm task ready
pi-messenger-swarm task stalled              # List tasks with no recent progress
pi-messenger-swarm task show task-3
pi-messenger-swarm task create --title "Fix token refresh race"
pi-messenger-swarm task create --title "..." --content "..." --depends-on task-2
pi-messenger-swarm task claim task-3
pi-messenger-swarm task unclaim task-3
pi-messenger-swarm task progress task-3 "Fixed the race"
pi-messenger-swarm task done task-3 "Auth middleware + tests"
pi-messenger-swarm task block task-3 --reason "Awaiting API key"
pi-messenger-swarm task unblock task-3
pi-messenger-swarm task reset task-3 [--cascade]
pi-messenger-swarm task archive-done
```

### Dynamic subagent spawning

```bash
pi-messenger-swarm spawn --role Researcher "Analyze competitor X"
pi-messenger-swarm spawn --role Analyst --persona "Skeptical market researcher" "Find productization gaps"
pi-messenger-swarm spawn --task-id task-1 --role Debugger "Fix the race condition"
pi-messenger-swarm spawn --agent-file agents/researcher.md "Analyze the codebase"
pi-messenger-swarm spawn --objective "Find bugs" --context "Focus on auth" --role Auditor "Review code"
pi-messenger-swarm spawn --message-file /tmp/mission.txt --role Researcher
pi-messenger-swarm spawn list
pi-messenger-swarm spawn history
pi-messenger-swarm spawn stop <id>
```

> **Shell safety**: When mission text contains backticks, `${...}`, parentheses, or other shell-sensitive characters, use `--message-file <path>` instead of a positional argument. Write the prompt to a temp file first to avoid bash interpolation corrupting the mission text.

#### Agent file format

`--agent-file` points to a markdown file with optional YAML frontmatter. The frontmatter supplies role/persona/model/objective defaults; the body after `---` becomes the system prompt.

```markdown
---
role: Security Reviewer
persona: Paranoid about edge cases
objective: Review code for security vulnerabilities
---

You are a security expert. Focus on input validation and auth boundaries.
```

Frontmatter fields (all optional):

| Field       | Purpose                                    |
| ----------- | ------------------------------------------ |
| `role`      | Agent role label (default: `Subagent`)     |
| `persona`   | Tone/behavior modifier                     |
| `model`     | Default model (overridable at spawn time)  |
| `objective` | Default mission (overridable via CLI text) |

If the file has no frontmatter, the entire file content is used as the system prompt with `role` defaulting to `Subagent`.

CLI flags override frontmatter values — for example, `--role` overrides `role:`, and positional mission text overrides `objective:`.

### Server management

| Command                        | Behavior                                    |
| ------------------------------ | ------------------------------------------- |
| `pi-messenger-swarm --status`  | Print health JSON or exit 1                 |
| `pi-messenger-swarm --start`   | Start the harness server                    |
| `pi-messenger-swarm --stop`    | Graceful shutdown                           |
| `pi-messenger-swarm --restart` | Soft restart: clear caches, preserve agents |
| `pi-messenger-swarm --logs`    | `tail -f` the server log                    |

### JSON passthrough

For programmatic use or complex actions, JSON is still accepted:

```bash
pi-messenger-swarm '{ "action": "join", "channel": "dev" }'
pi-messenger-swarm '{ "action": "spawn", "role": "Researcher", "message": "Analyze X", "taskId": "task-1" }'
```

## Swarm Philosophy

The swarm is self-organizing. Your role is participant, not manager.

### Pull-based, not push-based

Messages and state changes are written to the channel feed. Nobody pushes them to you — you must read the feed yourself between turns.

```bash
pi-messenger-swarm feed --limit 10
```

This is kafka-like: channels are durable logs, agents subscriibe by reading. If a teammate sent you a message, you'll find it in the feed. If you don't read it, it sits there until you do.

Good pattern: read the feed at decision points, then act.

- Before claiming: check what's ready
- After spawning: trust the agent to execute
- On uncertainty: read the feed, then message the agent directly
- Periodically: check for stalled tasks that need re-delegation

### Spawn-and-delegate, don't hoard

When you spawn subagents, you are the coordinator. You create the tasks, spawn the agents, then **step back**. Let the agents claim and execute their assigned work — do not claim those tasks yourself.

Your role after spawning:

- Monitor progress via `pi-messenger-swarm swarm` or `pi-messenger-swarm feed`
- Unblock agents when they hit problems (share context, clarify scope)
- Handle only tasks you did **not** delegate to a subagent

Anti-pattern: spawning agents then claiming all tasks yourself. This leaves spawned agents idle with nothing to do.

### Collaborate, don't micromanage

Subagents execute with full context. They report progress through task updates and messaging. Stay available for collaboration without inserting yourself into their loop.

Engage when:

- They reach out with a question or blocker
- You have relevant context they lack (share it proactively)
- Output reveals a misunderstanding of constraints
- The work naturally intersects with yours

Let them own their execution. Your value is in strategic context and unblocking, not status checks.

### Reading agent output

The feed (`pi-messenger-swarm feed`) shows one-line previews. For full findings and detail, use:

```bash
pi-messenger-swarm task show task-1   # Full spec + progress log
```

Agents are instructed to write all findings into `task progress` and `task done` messages — not just their response text — so everything is in the task record.

## Storage layout

Swarm data is **project-scoped by default** (isolated per project):

```
.pi/messenger/
├── channels/
│   └── <channel>.jsonl       # Metadata header (line 1) + feed events
├── tasks/                    # Task event JSONL (per session)
│   └── <session>.jsonl
├── agents/                   # Spawn event JSONL (per session)
│   └── <session>.jsonl
└── locks/                    # Race-safe coordination locks
```

### Override locations

```bash
# Custom directory
PI_MESSENGER_DIR=/path/to/dir pi

# Legacy global mode (all projects share state - not recommended)
PI_MESSENGER_GLOBAL=1 pi
```

## In-session shorthands (pi input only)

These work directly in the pi message box — no bash subshell required.
Autocomplete triggers on `#` and `##`.

| Input                                      | Effect                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `#AgentName hello`                         | Post a message to AgentName's current channel                            |
| `#memory remember this`                    | Post directly to a named channel                                         |
| `#all everyone sync up`                    | Broadcast to all active agents                                           |
| `##status`                                 | Run any CLI command inline; output shown to you, never sent to the model |
| `##task list`                              | Subcommands work too — Tab-autocomplete expands options                  |
| `##task block task-1 awaiting review`      | Bare reason text after id works; no `--reason` flag or quotes needed     |
| `##task done task-1 my multi-word summary` | Multi-word trailing args joined automatically                            |

Type `#` or `##` and press Tab to browse completions.
