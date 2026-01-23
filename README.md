<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**Multi-agent coordination for pi. No daemon, no server, just files.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

```typescript
pi_messenger({ join: true, spec: "./tasks.md" })
pi_messenger({ claim: "TASK-01", reason: "Implementing login flow" })
pi_messenger({ to: "GoldFalcon", message: "Done with auth, ready for review" })
```

## Quick Start

```typescript
// Join the agent mesh
pi_messenger({ join: true })
// → "Joined as SwiftRaven in backend on main. 2 peers active."

// See who's online
pi_messenger({ list: true })

// Send a message (wakes recipient immediately)
pi_messenger({ to: "GoldFalcon", message: "Taking the auth routes" })

// Reserve files (blocks other agents)
pi_messenger({ reserve: ["src/auth/"], reason: "Refactoring" })

// Release when done
pi_messenger({ release: true })
```

## Install

Copy to your extensions directory and restart pi:

```
~/.pi/agent/extensions/pi-messenger/
```

After joining, your agent name appears in the status bar:

```
msg: SwiftRaven (2 peers) ●3
```

## Features

**Discovery** — Agents register with memorable names (SwiftRaven, IronKnight). See who's active, what model they're using, which git branch they're on.

**Messaging** — Send messages between agents. Recipients wake up immediately and see the message as a steering prompt. Great for handoffs and coordination.

**File Reservations** — Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Swarm Coordination** — Multiple agents work on the same spec file. Claim tasks atomically, mark them complete, see who's doing what.

## Swarm Mode

When multiple agents work on the same spec:

```typescript
// Join with a spec file
pi_messenger({ join: true, spec: "./feature-spec.md" })

// See what's claimed and completed
pi_messenger({ swarm: true })
// → Completed: TASK-01, TASK-02
//   In progress: TASK-03 (you), TASK-04 (GoldFalcon)

// Claim a task (fails if already taken)
pi_messenger({ claim: "TASK-05" })

// Mark complete with notes
pi_messenger({ complete: "TASK-05", notes: "Added error handling" })
```

One claim per agent at a time. Claims are atomic and auto-cleanup when agents exit.

## Chat Overlay

`/messenger` opens an interactive chat UI:

```
╭─ Messenger ── SwiftRaven ── 2 peers ────────────────╮
│ ▸ Agents │ ● GoldFalcon │ ● IronKnight (1) │ + All  │
├─────────────────────────────────────────────────────┤
│ ./feature-spec.md:                                  │
│   SwiftRaven (you)   TASK-03    Implementing auth   │
│   GoldFalcon         TASK-04    API endpoints       │
├─────────────────────────────────────────────────────┤
│ > Agents overview                    [Tab] [Enter]  │
╰─────────────────────────────────────────────────────╯
```

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs |
| `↑` `↓` | Scroll history |
| `Enter` | Send message |
| `Esc` | Close |

## Tool Reference

```typescript
pi_messenger({
  // Join
  join?: boolean,              // Join the agent mesh
  spec?: string,               // Spec file to work on

  // Swarm
  swarm?: boolean,             // Get swarm status
  claim?: string,              // Claim a task
  unclaim?: string,            // Release without completing
  complete?: string,           // Mark task complete
  notes?: string,              // Completion notes

  // Messaging
  to?: string | string[],      // Recipient(s)
  broadcast?: boolean,         // Send to all
  message?: string,            // Message text

  // Reservations
  reserve?: string[],          // Paths to reserve
  reason?: string,             // Why reserving/claiming
  release?: string[] | true,   // Release reservations

  // Other
  rename?: string,             // Change your name
  list?: boolean,              // List active agents
})
```

## Configuration

Create `~/.pi/agent/pi-messenger.json`:

```json
{
  "autoRegister": false,
  "autoRegisterPaths": ["~/projects/team-collab"],
  "scopeToFolder": false
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |

**Path-based auto-register**: Use `autoRegisterPaths` instead of global auto-register. Supports `~` expansion and globs (`~/work/*`).

**Folder scoping**: When enabled, agents only discover others in the same working directory. Direct messaging by name still works across folders.

Manage paths via `/messenger config` or:

```typescript
pi_messenger({ autoRegisterPath: "add" })
pi_messenger({ autoRegisterPath: "list" })
```

## How It Works

```
~/.pi/agent/messenger/
├── registry/           # Agent registrations (PID, cwd, model, spec)
├── inbox/              # Message delivery
├── claims.json         # Active task claims
├── completions.json    # Completed tasks
└── swarm.lock          # Atomic lock for claims
```

File-based coordination. No daemon. Dead agents detected via PID and cleaned up automatically.

## License

MIT
