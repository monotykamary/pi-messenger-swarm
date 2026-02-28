<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-messenger-swarm/main/banner.png" alt="pi-messenger-swarm" width="1100">
</p>

# Pi Messenger (Swarm Mode)

Pi Messenger is a file-based multi-agent coordination extension for Pi.

- Agents in different terminals can join the same mesh
- Any agent can create and claim tasks
- Main agents can spawn dynamic subagents with custom roles/personas/objectives
- No daemon required (all state is file-backed)

This swarm-first fork is inspired by and built upon the original project by Nico Bailon:
https://github.com/nicobailon/pi-messenger

[![npm version](https://img.shields.io/npm/v/pi-messenger?style=for-the-badge)](https://www.npmjs.com/package/pi-messenger)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

## Screenshots

| Swarm Details | Swarm Messenger |
| --- | --- |
| ![Swarm Details](assets/swarm_details.jpg) | ![Swarm Messenger](assets/swarm_messenger.jpg) |

## Install

```bash
pi install npm:pi-messenger
```

## Quick Start

```ts
pi_messenger({ action: "join" })
pi_messenger({ action: "task.create", title: "Investigate auth timeout", content: "Repro + fix" })
pi_messenger({ action: "task.claim", id: "task-1" })
pi_messenger({ action: "task.progress", id: "task-1", message: "Found race in refresh flow" })
pi_messenger({ action: "task.done", id: "task-1", summary: "Fixed refresh lock + tests" })
```

Spawn a specialized subagent:

```ts
pi_messenger({
  action: "spawn",
  role: "Packaging Gap Analyst",
  persona: "Skeptical market researcher",
  message: "Find productization gaps in idea aggregation tools",
  content: "Focus on onboarding, monetization, and UX friction"
})
```

## Core Actions

### Coordination

- `join`
- `status`
- `list`
- `whois`
- `feed`
- `set_status`
- `send`
- `broadcast`
- `reserve`
- `release`
- `rename`

### Swarm Board

- `swarm` — summary of tasks + spawned agents

### Task Lifecycle

- `task.create`
- `task.list`
- `task.show`
- `task.ready`
- `task.claim` (alias: `task.start`)
- `task.unclaim` (alias: `task.stop`)
- `task.progress`
- `task.done`
- `task.block`
- `task.unblock`
- `task.reset` (`cascade: true` supported)
- `task.delete`
- `task.archive_done` (moves completed tasks to `.pi/messenger/swarm/archive/`)

Compatibility aliases:

- `claim` → `task.claim`
- `unclaim` → `task.unclaim`
- `complete` → `task.done`

### Subagent Management

- `spawn`
- `spawn.list`
- `spawn.stop`

## Overlay

Run `/messenger` to open the swarm overlay.

Overlay includes:

- live agent presence
- swarm task list/detail
- live feed
- DM/broadcast input

Planning UI and worker +/- controls were removed in swarm mode.

## Storage Layout

Global shared mesh state:

- `~/.pi/agent/messenger/registry`
- `~/.pi/agent/messenger/inbox`

Project-scoped swarm/task/feed state:

```
.pi/messenger/
├── feed.jsonl
└── swarm/
    ├── tasks/
    │   ├── task-1.json
    │   ├── task-1.md
    │   └── task-1.progress.md
    └── blocks/
```

## Legacy Orchestration Actions

Legacy PRD planner/worker/reviewer actions are disabled in swarm mode:

- `plan*`
- `work*`
- `review*`
- `crew.*` (legacy alias namespace)

Use `task.*`, `spawn.*`, and `swarm` instead.

## License

MIT
