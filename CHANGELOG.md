# Changelog

## [Unreleased]

## 0.7.2 - 2026-01-26

### Changed
- Added `pi-package` keyword for npm discoverability (pi v0.50.0 package system)

## 0.7.1 - 2026-01-24

### Added

- **Skill installation** - `crew.install` now installs `pi-messenger-crew` skill alongside agents
- **Skills directory** - Extension ships skills in `skills/` (moved from `crew/skills/`)
- **README documentation** - Added "Crew Install" section explaining what gets installed

### Fixed

- **Worker pi_messenger access** - Spawned workers now receive `--extension` flag, giving them access to `pi_messenger` tool for mesh coordination, file reservations, and sibling messaging

### Changed

- `crew.install` output now lists both agents and skills
- `crew.uninstall` removes both agents and skills

## 0.7.0 - 2026-01-23

### Breaking Changes

**Epic System Removed** - Crew has been simplified to a PRD-based workflow:

| Before | After |
|--------|-------|
| PRD → epic.create → plan epic → work on epic | PRD → plan → work → done |
| Task IDs: `c-1-abc.1`, `c-1-abc.2` | Task IDs: `task-1`, `task-2` |
| `target: "c-1-abc"` (epic ID) required | No target needed - works on current plan |

### Removed

- **Epic actions** - `epic.create`, `epic.show`, `epic.list`, `epic.close`, `epic.set_spec`
- **Checkpoint actions** - `checkpoint.save`, `checkpoint.restore`, `checkpoint.delete`, `checkpoint.list`
- **Epic validation** - `crew.validate` now validates the plan, not an epic
- **Epic-scoped task operations** - `task.ready` and `task.list` no longer require `epic` parameter
- **Files deleted:**
  - `crew/handlers/epic.ts` (~285 lines)
  - `crew/handlers/checkpoint.ts` (~190 lines)
  - Epic CRUD functions from `crew/store.ts` (~100 lines)

### Changed

- **`plan` action** - Now takes `prd` parameter instead of `target`:
  ```typescript
  // Before
  pi_messenger({ action: "plan", target: "c-1-abc" })
  
  // After
  pi_messenger({ action: "plan" })                    // Auto-discover PRD
  pi_messenger({ action: "plan", prd: "docs/PRD.md" }) // Explicit path
  ```

- **`work` action** - No longer requires target:
  ```typescript
  // Before
  pi_messenger({ action: "work", target: "c-1-abc" })
  
  // After
  pi_messenger({ action: "work" })                    // Work on current plan
  pi_messenger({ action: "work", autonomous: true })  // Autonomous mode
  ```

- **`status` action** - Now shows plan progress instead of epic list

- **Task IDs** - Simplified from `c-N-xxx.M` to `task-N`:
  ```typescript
  // Before
  pi_messenger({ action: "task.show", id: "c-1-abc.1" })
  
  // After
  pi_messenger({ action: "task.show", id: "task-1" })
  ```

- **Crew overlay** - Now shows flat task list under PRD name (no epic grouping)

### Storage

New simplified storage structure:
```
.pi/messenger/crew/
├── plan.json              # Plan metadata (PRD path, progress)
├── plan.md                # Gap analyst output
├── tasks/
│   ├── task-1.json        # Task metadata
│   ├── task-1.md          # Task spec
│   └── ...
├── artifacts/             # Unchanged
└── config.json            # Unchanged
```

### Benefits

1. **Simpler mental model** - PRD → Tasks → Done
2. **Less API surface** - 9 fewer actions to learn
3. **Cleaner IDs** - `task-1` instead of `c-1-abc.1`
4. **PRD is the spec** - No redundant epic spec
5. **Faster onboarding** - Fewer concepts to explain
6. **~475 lines removed** - Smaller, more maintainable codebase

---

## 0.6.3 - 2026-01-23

### Changed

- **Crew agent model assignments** - Optimized for cost and capability:
  - Scouts (deep): `claude-opus-4-5` - repo-scout, github-scout, practice-scout
  - Scouts (fast): `claude-haiku-4-5` - docs-scout, web-scout
  - Analysts: `claude-opus-4-5` - gap-analyst, interview-generator, plan-sync
  - Worker: `claude-opus-4-5` - quality code generation
  - Reviewer: `openai/gpt-5.2-high` - diverse perspective for review

- **Streamlined scout roster** - Reduced from 7 to 5 focused scouts:
  - Removed: `crew-memory-scout` (memory system not implemented)
  - Removed: `crew-epic-scout` (only useful for multi-epic projects)
  - Removed: `crew-docs-gap-scout` (merged into gap-analyst)
  - Renamed: `crew-github-scout` → `crew-web-scout` (web search focus)
  - New: `crew-github-scout` (gh CLI integration, sparse checkouts)

### Added

- **PRD auto-discovery** - Plan handler now finds and includes PRD/spec files:
  - Searches: `PRD.md`, `SPEC.md`, `REQUIREMENTS.md`, `DESIGN.md`, `PLAN.md`
  - Also checks `docs/` subdirectory
  - Content included in all scout prompts (up to 50KB)

- **Review feedback loop** - Workers see previous review feedback on retry:
  - `last_review` field added to Task type
  - Review handler stores feedback after each review
  - Worker prompt includes issues to fix on retry attempts

- **Scout skip logic** - web-scout and github-scout assess relevance first:
  - Can skip with explanation if not relevant to the feature
  - Saves time and API costs for internal/simple features

- **ARCHITECTURE.md** - New documentation with orchestration flow diagram, model summary, and agent inventory

### Fixed

- Template literal bug in worker prompt (epicId not interpolating)
- Retry detection off-by-one (now correctly shows attempt number)
- Case-insensitive filesystem duplicate PRD reads (uses realpath)
- Wave number tracking in autonomous mode (was off-by-one after addWaveResult)
- CREW_AGENTS list in install.ts (removed deleted agents, added crew-web-scout)
- Corrupted crew-plan-sync.md (had TypeScript code appended)

## 0.6.2 - 2026-01-23

### Changed

- Initial crew agent model assignments (superseded by 0.6.3)

## 0.6.1 - 2026-01-23

### Added

- **Planning Workflow Documentation** - README now explains how the `plan` action works:
  - Diagram showing scouts (parallel) → gap-analyst → tasks with dependencies
  - Clarifies that no special format is required for PRDs/specs
  - Example of starting from a PRD with `idea: true`

## 0.6.0 - 2026-01-23

### Added

**Crew: Task Orchestration** - A complete multi-agent task orchestration system for complex epics.

- **Epics & Tasks** - Hierarchical work items with dependency tracking
  - `epic.create`, `epic.show`, `epic.list`, `epic.close`, `epic.set_spec`
  - `task.create`, `task.show`, `task.list`, `task.start`, `task.done`, `task.block`, `task.unblock`, `task.ready`, `task.reset`

- **Planning** - Automated task breakdown with parallel scouts
  - `plan` action runs 7 scout agents in parallel to analyze codebase
  - Gap analyst synthesizes findings into task graph with dependencies
  - Supports planning from idea (`idea: true`) or existing epic

- **Work Execution** - Parallel worker spawning with concurrency control
  - `work` action executes ready tasks (dependencies satisfied)
  - `autonomous: true` flag for continuous wave execution until done/blocked
  - Configurable concurrency for scouts (default: 4) and workers (default: 2)
  - Auto-blocks tasks after `maxAttemptsPerTask` failures

- **Code Review** - Automated review with verdicts
  - `review` action for implementation (git diff) or plan review
  - SHIP / NEEDS_WORK / MAJOR_RETHINK verdicts with detailed feedback

- **Interview** - Clarification question generation
  - `interview` action generates 20-40 deep questions
  - Outputs JSON file for pi's interview tool

- **Sync** - Downstream spec updates
  - `sync` action updates dependent task specs after completion

- **Checkpoints** - State save/restore for recovery
  - `checkpoint.save`, `checkpoint.restore`, `checkpoint.delete`, `checkpoint.list`

- **Status & Maintenance**
  - `crew.status` - Overall crew status with progress metrics
  - `crew.validate` - Validate epic structure and dependencies
  - `crew.agents` - List available crew agents by role
  - `crew.install` / `crew.uninstall` - Agent management

- **Crew Overlay Tab** - Visual epic/task tree in `/messenger` overlay
  - Tab bar shows "Crew (N)" with active epic count
  - Expand/collapse epics with Enter key
  - Status icons: ✓ done, ● in_progress, ○ todo, ✗ blocked
  - Shows assigned agent, dependencies, and block reasons
  - Autonomous mode status bar: wave number, progress, ready count, timer

- **12 Crew Agents** - Auto-installed on first use of `plan`, `work`, or `review`
  - 7 scouts: repo, practice, docs, github, epic, docs-gap, memory
  - Plus: worker, reviewer, gap-analyst, interview-generator, plan-sync

- **Action-based API** - Consistent `action` parameter pattern
  - Example: `pi_messenger({ action: "epic.create", title: "OAuth Login" })`
  - 24 new crew actions, 38 total actions through one tool

### Storage

New directory `.pi/messenger/crew/` (per-project):
- `epics/*.json` - Epic metadata
- `specs/*.md` - Epic specifications  
- `tasks/*.json` - Task metadata
- `tasks/*.md` - Task specifications
- `blocks/*.md` - Block context for blocked tasks
- `checkpoints/` - Saved state snapshots
- `artifacts/` - Debug artifacts (input/output/jsonl per run)
- `config.json` - Project-level config overrides

### Configuration

New `crew` section in `~/.pi/agent/pi-messenger.json`:
```json
{
  "crew": {
    "concurrency": { "scouts": 4, "workers": 2 },
    "review": { "enabled": true, "maxIterations": 3 },
    "work": { "maxAttemptsPerTask": 5, "maxWaves": 50 },
    "artifacts": { "enabled": true, "cleanupDays": 7 }
  }
}
```

### Fixed

- 12 bugs fixed during implementation review:
  - **Critical:** `loadCrewConfig` called with wrong path in plan.ts and work.ts
  - Double-counting bug in work.ts (tasks in both `failed` and `blocked` arrays)
  - O(n²) complexity in plan.ts task creation loop
  - O(n²) complexity in agents.ts worker spawn loop
  - Invalid status icon map in epic.ts (missing `blocked`, `archived`)
  - Various unused imports and variables cleaned up

---

## 0.5.1 - 2026-01-22

### Added

- **Path-based auto-register** - New `autoRegisterPaths` config option allows specifying folders where agents should auto-join the mesh, instead of global auto-register. Supports `~` expansion and glob patterns (`~/work/*`).
- **Folder scoping** - New `scopeToFolder` config option limits agent visibility to the same working directory. When enabled, agents only see other agents in the same folder (broadcasts are scoped, but direct messaging by name still works).
- **Auto-register path management (tool)** - New `autoRegisterPath` parameter:
  - `pi_messenger({ autoRegisterPath: "add" })` - Add current folder to auto-register list
  - `pi_messenger({ autoRegisterPath: "remove" })` - Remove current folder
  - `pi_messenger({ autoRegisterPath: "list" })` - Show all configured paths
- **Config TUI command** - `/messenger config` opens an overlay to manage auto-register paths with keyboard navigation.

### Changed

- Auto-register logic now checks both `autoRegister` (global) and `autoRegisterPaths` (path-based). If either matches, the agent auto-joins.
- `getActiveAgents()` now filters by cwd when `scopeToFolder` is enabled.

## 0.5.0 - 2026-01-20

### Added

- **Swarm coordination** - Agents can now coordinate on shared spec files with atomic task claiming
- **Spec registration** - `pi_messenger({ spec: "path/to/spec.md" })` registers your working spec
- **Task claiming** - `pi_messenger({ claim: "TASK-01" })` atomically claims a task in your spec
- **Task completion** - `pi_messenger({ complete: "TASK-01", notes: "..." })` marks tasks done with notes
- **Task unclaiming** - `pi_messenger({ unclaim: "TASK-01" })` releases a claim without completing
- **Swarm status** - `pi_messenger({ swarm: true })` shows all agents' claims and completions
- **Spec-scoped swarm** - `pi_messenger({ swarm: true, spec: "path" })` shows status for one spec only
- **Join with spec** - `pi_messenger({ join: true, spec: "path" })` joins and registers spec atomically
- **Single-claim-per-agent rule** - Must complete or unclaim before claiming another task
- **Stale claim cleanup** - Claims from dead agents (PID gone + lock >10s old) are automatically cleaned

### Changed

- **Agents tab in overlay** - Now groups agents by spec with claims displayed
- **Status output** - Now includes current spec and active claim when set
- **List output** - Now shows spec and claim status for each agent

### Storage

New files in `~/.pi/agent/messenger/`:
- `claims.json` - Active task claims by spec
- `completions.json` - Completed tasks by spec
- `swarm.lock` - Atomic lock for claim/complete mutations

### Fixed

- **Safe completion write order** - Completions are now written before claims removal, so if the second write fails the task completion is still recorded
- **Overlay scroll reset on agent death** - When an agent dies and the overlay auto-switches to another tab, scroll position is now properly reset
- **Type-safe result handling** - Added proper type guards (`isClaimSuccess`, `isUnclaimNotYours`, etc.) for discriminated union result types, replacing fragile `as` casts
- **I/O error cleanup** - If registration write succeeds but read-back fails (extremely rare I/O error), the orphaned file is now cleaned up
- **Single agent lookup for reservations** - `ReservationConflict` now includes full agent registration, eliminating redundant disk reads when blocking reserved files

## 0.4.0 - 2026-01-21

### Changed

- **Opt-in registration** - Agents no longer auto-register on startup. Use `pi_messenger({ join: true })` to join the mesh, or open `/messenger` which auto-joins. This reduces context pollution for sessions that don't need multi-agent coordination.
- **New `autoRegister` config** - Set to `true` to restore the old auto-register-on-startup behavior.

### Fixed

- **Read operations no longer blocked by reservations** - Previously, reading reserved files was blocked. Now only `edit` and `write` operations are blocked, allowing agents to read files for context even when another agent has reserved them.

## 0.3.0 - 2026-01-21

### Added

- **Agent differentiation** - Agents are now easier to distinguish when multiple work in the same folder
- **Git branch detection** - Automatically detects and displays git branch (or short SHA for detached HEAD)
- **Adaptive display modes** - List and overlay views adapt based on agent context:
  - Same folder + branch: Compact view, branch in header
  - Same folder, different branches: Shows branch per agent
  - Different folders: Shows folder per agent
- **Location awareness** - Status command now shows `Location: folder (branch)`
- **Enhanced context** - Registration and first-contact messages include location info
- **Improved reservation display** - Uses 🔒 prefix, truncates long paths from the left preserving filename

### Changed

- Reservation conflict messages now show the blocking agent's location: `Reserved by: X (in folder on branch)`
- First contact message format: `*X is in folder on branch (model)*`
- Tab bar adapts: name only (same context), name:branch (different branches), name/folder (different folders)
- Status details object now includes `folder` and `gitBranch` for programmatic access

### Fixed

- **Agent identity detection** - When an agent quits and a new pi instance registers with the same name, recipients now correctly see first-contact details. Previously, `seenSenders` tracked names only; now it tracks `name -> sessionId` to detect identity changes.
- **Registration race condition** - Added write-then-verify check to prevent two agents from claiming the same name simultaneously. If another agent wins the race, auto-generated names retry with a fresh lookup; explicit names fail with a clear error.
- **Rename race condition** - Added write-then-verify check to `renameAgent()` to prevent two agents from renaming to the same name simultaneously. If verification fails, returns "race_lost" error and the agent keeps its old name.

### Performance

- **Cached filtered agents** - `getActiveAgents()` now caches filtered results per agent name, avoiding repeated array allocations on every call.
- **Memoized agent colors** - `agentColorCode()` now caches computed color codes, avoiding hash recalculation on every render.
- **Overlay render cache** - Sorted agent list is now cached within each render cycle, avoiding redundant sort operations.
- **Reduced redundant calls** - `formatRelativeTime()` result is now reused in message box rendering instead of being called twice.

### Documentation

- **README overhaul** - New banner image showing connected pi symbols, punchy tagline, license/platform badges, comparison table, organized features section, keyboard shortcuts table, and streamlined layout following reference README patterns.

## 0.2.1 - 2026-01-20

### Fixed

- **Performance: Agent registry caching** - `getActiveAgents()` now caches results for 1 second, dramatically reducing disk I/O. Previously, every keypress in the overlay and every tool_call for read/edit/write caused full registry scans.
- **Performance: Watcher debouncing** - File watcher events are now debounced with 50ms delay, coalescing rapid filesystem events into a single message processing call.
- **Stability: Message processing guard** - Concurrent calls to `processAllPendingMessages()` are now serialized to prevent race conditions when watcher events and turn_end overlap.
- **Stability: MessengerState type** - Added `watcherDebounceTimer` field for proper debounce timer management.

## 0.2.0 - 2026-01-20

### Added

- **Chat overlay** - `/messenger` now opens an interactive overlay instead of a menu. Full chat interface with tabs for each agent, message history, and an input bar at the bottom.
- **Message history** - Messages persist in memory for the session (up to 50 per conversation). Scroll through history with arrow keys.
- **Unread badges** - Status bar shows total unread count. Tab bar shows per-agent unread counts that clear when you switch to that tab.
- **Broadcast tab** - "+ All" tab for sending messages to all agents at once. Shows your outgoing broadcast history.
- **Agent colors** - Each agent name gets a consistent color based on a hash of their name. Makes it easy to distinguish agents in conversations.
- **Agent details** - When viewing a conversation with no messages, shows the agent's working directory, model, and file reservations.
- **Context injection** - Agents now receive orientation on startup and helpful context with messages:
  - Registration message explaining multi-agent environment (once per session)
  - Reply hint showing how to respond to messages
  - Sender details (cwd, model) on first contact from each agent
- **Configuration file** - `~/.pi/agent/pi-messenger.json` for customizing context injection. Supports `contextMode: "full" | "minimal" | "none"`.

### Changed

- `/messenger` command now opens overlay (was: interactive menu with select prompts)
- Status bar now shows unread count badge when messages are waiting

### Fixed

- Message delivery order: files are now deleted after successful delivery, not before (prevents message loss if delivery fails)
- ANSI escape codes in message text are now stripped to prevent terminal injection
- Watcher recovery: if the inbox watcher dies after exhausting retries, it now automatically recovers on the next turn or session event
- Small terminal handling: overlay now handles very small terminal windows gracefully with minimum height safeguards

## 0.1.0 - 2026-01-20

Initial release.

- Agent discovery with auto-generated memorable names (SwiftRaven, GoldFalcon, etc.)
- Direct messaging between agents with immediate delivery
- Broadcast messaging to all active agents
- File reservations with conflict detection
- Message renderer for incoming agent messages
- Status bar integration showing agent name and peer count
