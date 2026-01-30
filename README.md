<p>
  <img src="banner.png" alt="pi-messenger" width="1100">
</p>

# Pi Messenger

**What if multiple agents in different terminals sharing a folder could talk to each other like they're in a chat room?** Join, see who's online and what they're doing. Claim tasks, reserve files, send messages. Built on [Pi's](https://github.com/badlogic/pi-mono) extension system. No daemon, no server, just files.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-blue?style=for-the-badge)]()

> ⚠️ **Beta** - Core messaging, presence, and file reservations are stable. **Crew task orchestration** (plan/work/review) is newer and not fully tested yet. Please [open an issue](https://github.com/nicobailon/pi-messenger/issues) if you encounter problems.

Pi-messenger adds a `pi_messenger` tool that **agents use** for coordination. You don't type these commands - you ask your agent to do things, and it calls `pi_messenger` behind the scenes.

## Quick Start

### Multi-Agent Coordination

Once joined (manually or via auto-join config), agents can coordinate:

```typescript
pi_messenger({ action: "reserve", paths: ["src/auth/"], reason: "Refactoring" })
// → Reserved src/auth/ - other agents will be blocked

// ... does the work ...

pi_messenger({ action: "release" })
// → Released all reservations
```

> **Tip:** Set `autoRegister: true` in your config to auto-join on startup. Otherwise, agents join with `pi_messenger({ action: "join" })`.

### Crew Task Orchestration

Ask your agent to plan and execute from a PRD:

```typescript
pi_messenger({ action: "plan" })
// → Planner analyzes codebase, creates tasks

pi_messenger({ action: "work", autonomous: true })
// → Workers execute tasks in waves until done
```

> **Note:** Crew agents (planner, workers, reviewers) automatically join the mesh as their first action.

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

**Living Presence** - Agents have rich presence with status indicators (🟢 active, 🟡 idle, 🟠 away, 🔴 stuck), tool call counts, token usage, and auto-generated status messages like "on fire 🔥" or "debugging...".

**Activity Feed** - A unified timeline of everything happening: edits, commits, test runs, messages, task starts/completions. Crew events appear inline with a `[Crew]` prefix.

**Discovery** - Agents register with memorable themed names (SwiftRaven, LunarDust, OakTree). See who's active, what they're working on, which model and git branch they're on.

**Messaging** - Send messages between agents. Recipients wake up immediately and see the message as a steering prompt. Great for handoffs and coordination.

**File Reservations** - Claim files or directories. Other agents get blocked with a clear message telling them who to coordinate with. Auto-releases on exit.

**Stuck Detection** - Agents idle too long with an open task or reservation are flagged as stuck. You get a notification so you can intervene.

**Human as Participant** - Your interactive pi session appears in the agent list with `(you)`. Same activity tracking, same status messages. You can chat from the overlay.

**Swarm Coordination** - Multiple agents work on the same spec file. Claim tasks atomically, mark them complete, see who's doing what.

## Chat Overlay

`/messenger` opens an interactive overlay with agent presence, activity feed, and chat:

```
╭─ Messenger ── 3 agents ── myapp ────────────────────╮
│                                                      │
│ 🟢 SwiftRaven (you)                                  │
│    editing login.ts - 12 tools - 31.0k - on fire 🔥  │
│                                                      │
│ 🟡 GoldFalcon                             idle 2m    │
│    8 tools - 24.1k - 📁 src/api/                     │
│                                                      │
│ 🔴 IronKnight                             stuck      │
│    3 tools - 16.4k                                   │
│                                                      │
│ Activity                                             │
│ 10:42 SwiftRaven editing login.ts                    │
│ 10:40 GoldFalcon → SwiftRaven: "auth done?"          │
│ 10:38 SwiftRaven committed "feat: add OAuth"         │
│ 10:35 [Crew] GoldFalcon started task-03              │
├──────────────────────────────────────────────────────┤
│ > @GoldFalcon almost done                [Tab] [Enter]│
╰──────────────────────────────────────────────────────╯
```

Chat input supports `@Name msg` for DMs and `@all msg` for broadcasts. Text without `@` broadcasts from the Agents tab or DMs the selected agent tab.

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Switch tabs (Agents, Crew, agent DMs, All) |
| `↑` `↓` | Scroll history / navigate crew tasks |
| `Enter` | Send message |
| `Esc` | Close |

## Crew: Task Orchestration

Crew provides multi-agent task orchestration with a simplified PRD-based workflow.

### Basic Workflow

1. **Plan** - Planner analyzes your codebase and PRD, creates tasks
2. **Work** - Workers implement tasks in parallel waves
3. **Review** - Reviewer checks each implementation

```typescript
// Plan from your PRD (auto-discovers PRD.md, SPEC.md, etc.)
pi_messenger({ action: "plan" })

// Or specify PRD path explicitly
pi_messenger({ action: "plan", prd: "docs/PRD.md" })

// Execute tasks (spawns parallel workers)
pi_messenger({ action: "work" })

// Or run autonomously until done/blocked
pi_messenger({ action: "work", autonomous: true })

// Review a specific task
pi_messenger({ action: "review", target: "task-1" })
// → SHIP ✅ or NEEDS_WORK 🔄
```

### Crew API

**Planning**
| Action | Description | Example |
|--------|-------------|---------|
| `plan` | Create plan from PRD | `{ action: "plan" }` or `{ action: "plan", prd: "..." }` |
| `status` | Show progress | `{ action: "status" }` |

**Work Execution**
| Action | Description | Example |
|--------|-------------|---------|
| `work` | Run ready tasks | `{ action: "work" }` |
| `work` (auto) | Run until done/blocked | `{ action: "work", autonomous: true }` |

**Task Management**
| Action | Description | Example |
|--------|-------------|---------|
| `task.show` | Show task details | `{ action: "task.show", id: "task-1" }` |
| `task.list` | List all tasks | `{ action: "task.list" }` |
| `task.start` | Start task | `{ action: "task.start", id: "task-1" }` |
| `task.done` | Complete task | `{ action: "task.done", id: "task-1", summary: "..." }` |
| `task.block` | Block task | `{ action: "task.block", id: "task-1", reason: "..." }` |
| `task.unblock` | Unblock task | `{ action: "task.unblock", id: "task-1" }` |
| `task.ready` | List ready tasks | `{ action: "task.ready" }` |
| `task.reset` | Reset task | `{ action: "task.reset", id: "task-1", cascade: true }` |

**Review**
| Action | Description | Example |
|--------|-------------|---------|
| `review` | Review implementation | `{ action: "review", target: "task-1" }` |

**Maintenance**
| Action | Description | Example |
|--------|-------------|---------|
| `crew.status` | Overall status | `{ action: "crew.status" }` |
| `crew.validate` | Validate plan | `{ action: "crew.validate" }` |
| `crew.agents` | List crew agents | `{ action: "crew.agents" }` |
| `crew.install` | Install crew agents | `{ action: "crew.install" }` |

### Planning Workflow

The `plan` action runs a multi-pass planning loop: the planner drafts tasks, a reviewer checks them against the PRD, and the planner refines until SHIP or `planning.maxPasses` is reached. All passes and feedback are stored in `.pi/messenger/crew/planning-progress.md`.

```
┌─────────────────────────────────────────────────────────────────┐
│  Your Project                                                    │
│  ├── PRD.md            ◄── Planner discovers and reads these    │
│  ├── DESIGN.md                                                   │
│  ├── src/                                                        │
│  └── ...                                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Planner (opus)                                                  │
│  ├── Explores codebase structure and patterns                    │
│  ├── Reads project documentation                                 │
│  ├── Identifies gaps, edge cases, security concerns              │
│  └── Drafts task breakdown with dependencies                     │
└─────────────────────────────────────────────────────────────────┘
                              │ append to
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  planning-progress.md (history + feedback)                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Reviewer (gpt-5.2-high)                                          │
│  ├── SHIP  ✅  or NEEDS_WORK 🔄                                  │
│  └── Feeds back into the next planner pass                       │
└─────────────────────────────────────────────────────────────────┘
                              │ SHIP
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Result: Tasks with Dependencies                                 │
│  ├── task-1: Setup types        (no deps)                       │
│  ├── task-2: Core logic         (depends on task-1)             │
│  ├── task-3: API endpoints      (depends on task-1)             │
│  └── task-4: Tests              (depends on task-2, task-3)     │
└─────────────────────────────────────────────────────────────────┘
```

**No special format required** -- just put your docs in the project. The planner finds and reads markdown files, READMEs, and code comments.

### How Work Execution Works

Crew doesn't run tasks sequentially. Tasks form a dependency graph, and the work handler executes them in **waves** based on what's ready:

```
Wave 1:  task-1 (no deps)  ─┐
         task-3 (no deps)  ─┤── run in parallel
                             │
Wave 2:  task-2 (→ task-1) ─┤── task-1 done, task-2 unblocked
         task-4 (→ task-3) ─┘── task-3 done, task-4 unblocked

Wave 3:  task-5 (→ task-2, task-4) ── both deps done
```

A task is **ready** when its status is pending and all its dependencies are completed. Each wave picks all ready tasks (up to `concurrency.workers`), spawns parallel workers, waits for them to finish, then checks what's newly unblocked. Independent tasks — those that don't depend on each other — run concurrently in the same wave.

The planner structures tasks to maximize this parallelism. Foundation work (types, config, schemas) has no dependencies so it starts immediately. Features that don't touch each other get separate dependency chains so they can run in parallel. Tasks that need shared work done first (tests, integration, docs) depend on the tasks that produce it.

A single `work` call runs one wave. Autonomous mode (`autonomous: true`) runs waves back-to-back until everything is done or blocked.

### Autonomous Mode

Run tasks continuously until completion:

```typescript
pi_messenger({ action: "work", autonomous: true })
```

Autonomous mode:
- Executes waves of parallel workers
- Auto-blocks on failure
- Stops when all tasks done or blocked
- Respects `maxWaves` limit (default: 50)

### Crew Overlay Tab

The `/messenger` overlay includes a Crew tab showing task status:

```
╭─ Messenger ── 3 agents ── myapp ──────────────────────╮
│ Agents │ ▸ Crew (2/5) │ ● GoldFalcon │ + All         │
├──────────────────────────────────────────────────────┤
│                                                      │
│  📋 docs/PRD.md                              [2/5]   │
│                                                      │
│  ✓ task-1  Setup OAuth config                        │
│  ✓ task-2  Implement token storage                   │
│  ● task-3  Add Google provider (SwiftRaven)          │
│  ○ task-4  Add GitHub provider → task-2              │
│  ○ task-5  Write tests → task-3, task-4              │
│                                                      │
├──────────────────────────────────────────────────────┤
│ ● AUTO Wave 2 │ 2/5 done │ 1 ready │ ⏱️ 3:42        │
╰──────────────────────────────────────────────────────╯
```

### Crew Data Storage

```
.pi/messenger/crew/
├── plan.json               # Plan metadata (PRD path, progress)
├── plan.md                 # Planner output
├── planning-progress.md    # Planning loop history + feedback
├── tasks/
│   ├── task-1.json         # Task metadata
│   ├── task-1.md           # Task specification
│   └── ...
├── blocks/                 # Block context for blocked tasks
├── artifacts/              # Debug artifacts
└── config.json             # Project-level crew config
```

### Crew Configuration

Add to `~/.pi/agent/pi-messenger.json`:

```json
{
  "crew": {
    "concurrency": { "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "planning": { "maxPasses": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 }
  }
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `concurrency.workers` | Max parallel workers during work | `2` |
| `review.enabled` | Enable review functionality | `true` |
| `review.maxIterations` | Max review iterations per task | `3` |
| `planning.maxPasses` | Max planner passes before accepting last output | `3` |
| `work.maxAttemptsPerTask` | Retries before blocking a task | `5` |
| `work.maxWaves` | Max waves in autonomous mode | `50` |

### Crew Install

Crew agents are **auto-installed** on first use of `plan`, `work`, or `review`. To manually install or update:

```typescript
pi_messenger({ action: "crew.install" })
```

**What gets installed:**
- **5 agents** in `~/.pi/agent/agents/` (planner, worker, reviewer, interview-generator, plan-sync)
- **1 skill** in `~/.pi/agent/skills/` (pi-messenger-crew quick reference)

To remove:
```typescript
pi_messenger({ action: "crew.uninstall" })
```

## Tool Reference

### Action-Based API (Recommended)

**Coordination**
| Action | Description |
|--------|-------------|
| `join` | Join the agent mesh |
| `list` | List agents with presence info |
| `status` | Show your status or crew progress |
| `whois` | Detailed info about an agent |
| `feed` | Show activity feed |
| `set_status` | Set custom status message (omit `message` to clear) |
| `send` | Send DM (requires `to` + `message`) |
| `broadcast` | Broadcast to all (requires `message`) |
| `reserve` | Reserve files (requires `paths`) |
| `release` | Release reservations (optional `paths`, or releases all) |
| `rename` | Change your name (requires `name`) |
| `swarm` | Show swarm task status |
| `claim` | Claim a swarm task (requires `taskId`) |
| `unclaim` | Release a swarm claim (requires `taskId`) |
| `complete` | Complete a swarm task (requires `taskId`) |

```typescript
pi_messenger({
  action: string,              // Action to perform

  // Coordination
  name?: string,               // For whois, rename
  message?: string,            // For send, broadcast, set_status
  to?: string | string[],      // For send
  paths?: string[],            // For reserve, release
  reason?: string,             // For reserve, claim, task.block
  limit?: number,              // For feed (default: 20)

  // Plan
  prd?: string,                // PRD file path

  // Task identifiers
  id?: string,                 // Task ID (task-N)
  taskId?: string,             // Swarm task ID
  target?: string,             // Target for review

  // Creation
  title?: string,              // For task.create
  dependsOn?: string[],        // Task dependencies

  // Completion
  summary?: string,            // For task.done

  // Work options
  autonomous?: boolean,        // Run continuously
  concurrency?: number,        // Override concurrency

  // Reset
  cascade?: boolean,           // Reset dependent tasks too
})
```

### Legacy API

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
  "scopeToFolder": false,
  "nameTheme": "default",
  "stuckThreshold": 900,
  "stuckNotify": true
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `autoRegister` | Join mesh on startup | `false` |
| `autoRegisterPaths` | Folders where auto-join is enabled (supports `*` globs) | `[]` |
| `scopeToFolder` | Only see agents in same directory | `false` |
| `nameTheme` | Name generation theme: `default`, `nature`, `space`, `minimal`, `custom` | `"default"` |
| `nameWords` | Custom theme words: `{ adjectives: [...], nouns: [...] }` | — |
| `feedRetention` | Max events kept in activity feed | `50` |
| `stuckThreshold` | Seconds of inactivity before stuck detection | `900` (15m) |
| `stuckNotify` | Show notification when a peer appears stuck | `true` |
| `autoStatus` | Auto-generate status messages from activity | `true` |
| `crewEventsInFeed` | Include crew task events in activity feed | `true` |
| `contextMode` | Context injection level: `full`, `minimal`, `none` | `"full"` |

## How It Works

```
~/.pi/agent/messenger/
├── registry/           # Agent registrations (PID, cwd, model, activity, tokens)
├── inbox/              # Message delivery
├── feed.jsonl          # Activity feed (append-only, pruned on startup)
├── claims.json         # Active task claims
├── completions.json    # Completed tasks
└── swarm.lock          # Atomic lock for claims
```

File-based coordination. No daemon. Activity tracking updates the registry every 10 seconds via debounced flushes. Dead agents detected via PID and cleaned up automatically - a "leave" event is logged when stale registrations are removed.

## Credits

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by [@doodlestein](https://x.com/doodlestein) - Inspiration for agent-to-agent messaging
- **[Pi coding agent](https://github.com/badlogic/pi-mono/)** by [@badlogicgames](https://x.com/badlogicgames)

## License

MIT
