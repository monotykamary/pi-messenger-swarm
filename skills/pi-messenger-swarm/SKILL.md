---
name: pi-messenger-swarm
description: Multi-agent coordination and task orchestration. Run actions via the `pi-messenger-swarm` CLI — a persistent harness server handles all state. Use for swarm coordination, task management, agent messaging, and subagent spawning.
---

# Pi-Messenger Swarm Skill

Multi-agent coordination via the `pi-messenger-swarm` CLI.

The CLI auto-spawns a long-lived HTTP server (the **harness**) on first use. Every call dispatches an action to the harness, which holds persistent state — agent registrations, task store, feed — across calls.

- No planning agent
- No fixed planner/worker/reviewer roles
- Any joined or spawned agent can create/claim/complete tasks

## Setup

If installed globally (`npm install -g pi-messenger-swarm`), the `pi-messenger-swarm` command is on your PATH. Otherwise, the extension installs a shell wrapper script at `~/.pi/agent/bin/pi-messenger-swarm` which pi adds to PATH automatically — no manual setup needed.

Agent identity is resolved automatically by the CLI — it walks its own process tree to find the parent `pi` process and sends the PID to the harness server, which matches it against registrations on disk. No environment variables or configuration needed.

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

3. Claim work before implementing

```bash
pi-messenger-swarm task claim task-1
```

4. Reserve files before edits

```bash
pi-messenger-swarm reserve src/auth/ --reason task-1
```

5. Log progress and complete

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
pi-messenger-swarm spawn list
pi-messenger-swarm spawn history
pi-messenger-swarm spawn stop <id>
```

### Server management

| Command                        | Behavior                    |
| ------------------------------ | --------------------------- |
| `pi-messenger-swarm --status`  | Print health JSON or exit 1 |
| `pi-messenger-swarm --start`   | Start the harness server    |
| `pi-messenger-swarm --stop`    | Graceful shutdown           |
| `pi-messenger-swarm --restart` | Stop + start fresh          |
| `pi-messenger-swarm --logs`    | `tail -f` the server log    |

### JSON passthrough

For programmatic use or complex actions, JSON is still accepted:

```bash
pi-messenger-swarm '{ "action": "join", "channel": "dev" }'
pi-messenger-swarm '{ "action": "spawn", "role": "Researcher", "message": "Analyze X", "taskId": "task-1" }'
```

## Swarm Philosophy

The swarm is self-organizing. Your role is participant, not manager.

### Event-driven, not poll-driven

State changes arrive when they happen. The system surfaces updates via the feed and task notifications. Checking repeatedly adds latency and wastes context.

Good pattern: inspect once at decision points, act, move on.

- Before claiming: check what's ready
- After spawning: trust the agent to execute
- On uncertainty: message the agent directly

### Spawn-and-collaborate, don't coordinate

Subagents execute with full context. They report progress through task updates and messaging. Stay available for collaboration without inserting yourself into their loop.

Engage when:

- They reach out with a question or blocker
- You have relevant context they lack (share it proactively)
- Output reveals a misunderstanding of constraints
- The work naturally intersects with yours

Let them own their execution. Your value is in strategic context and unblocking, not status checks.

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
