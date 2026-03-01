---
name: pi-messenger-swarm
description: Use pi-messenger in swarm mode. Agents can create/claim tasks directly and spawn dynamic subagents with role/persona/mission prompts.
---

# Pi-Messenger Swarm Skill

Pi-messenger now runs in **swarm-first mode**.

- No planning agent
- No fixed planner/worker/reviewer roles
- Any joined or spawned agent can create/claim/complete tasks

## Core protocol (all agents)

1. Join first
```typescript
pi_messenger({ action: "join" })
```

2. Inspect swarm state
```typescript
pi_messenger({ action: "swarm" })
pi_messenger({ action: "task.list" })
```

3. Claim work before implementing
```typescript
pi_messenger({ action: "task.claim", id: "task-1" })
```

4. Reserve files before edits
```typescript
pi_messenger({ action: "reserve", paths: ["src/auth/"], reason: "task-1" })
```

5. Log progress and complete
```typescript
pi_messenger({ action: "task.progress", id: "task-1", message: "Implemented JWT verification" })
pi_messenger({ action: "task.done", id: "task-1", summary: "Auth middleware + tests" })
pi_messenger({ action: "release" })
```

## Task operations

```typescript
pi_messenger({ action: "task.create", title: "Fix token refresh race", content: "...", dependsOn: ["task-2"] })
pi_messenger({ action: "task.list" })
pi_messenger({ action: "task.show", id: "task-3" })
pi_messenger({ action: "task.ready" })
pi_messenger({ action: "task.unclaim", id: "task-3" })
pi_messenger({ action: "task.block", id: "task-3", reason: "Awaiting API key" })
pi_messenger({ action: "task.unblock", id: "task-3" })
pi_messenger({ action: "task.reset", id: "task-3", cascade: true })
pi_messenger({ action: "task.archive_done" })
```

## Dynamic subagent spawning

Spawn specialized subagents at runtime:

```typescript
pi_messenger({
  action: "spawn",
  role: "Packaging Gap Analyst",
  persona: "Skeptical market researcher",
  message: "Analyze idea aggregation products and find productization gaps",
  content: "Focus on monetization and onboarding friction",
  taskId: "task-6",
  model: "anthropic/claude-haiku-4-5"
})
```

Manage spawned agents:

```typescript
pi_messenger({ action: "spawn.list" })
pi_messenger({ action: "spawn.stop", id: "<spawn-id>" })
```

## Messaging and coordination

```typescript
pi_messenger({ action: "send", to: "OtherAgent", message: "Need your API shape before I commit" })
pi_messenger({ action: "broadcast", message: "Claimed task-4, touching src/auth/session.ts" })
```

## Swarm Philosophy

The swarm is self-organizing. Your role is participant, not manager.

### Event-driven, not poll-driven

State changes arrive when they happen. The system surfaces updates via the feed and task notifications. Checking repeatedly adds latency and wastes context.

Good pattern: inspect once at decision points, act, move on.
- Before claiming: check what's ready
- After spawning: trust the agent to execute
- On uncertainty: message the agent directly

Avoid loops that poll status. The system already does this.

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
├── feed.jsonl
├── swarm/
│   ├── tasks/
│   │   ├── task-1.json
│   │   ├── task-1.md
│   │   └── task-1.progress.md
│   └── blocks/
└── locks/              # Race-safe coordination locks
```

This prevents cross-project agent contamination. Agents only see other agents in the same project.

### Override locations

```bash
# Custom directory
PI_MESSENGER_DIR=/path/to/dir pi

# Legacy global mode (all projects share state - not recommended)
PI_MESSENGER_GLOBAL=1 pi
```
