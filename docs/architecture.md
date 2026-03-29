# Pi Messenger Internal Architecture

This project is intentionally shipped as a small Pi extension entrypoint with a set of focused internal modules.

## Top-level roles

- `index.ts` — extension composition root and lifecycle wiring
- `store.ts` — compatibility facade for storage/runtime helpers
- `handlers.ts` — compatibility facade for tool action handlers
- `overlay.ts` — swarm overlay controller and frame assembly

## Internal modules

### `store/`

Runtime persistence and coordination are split by responsibility:

- `store/shared.ts` — shared filesystem/session/channel helpers
- `store/messaging.ts` — inbox delivery, message draining, watcher lifecycle
- `store/legacy-claims.ts` — legacy spec-based claim/completion compatibility
- `store/registry.ts` — agent registry, session rebinding, rename/join, routing helpers

### `handlers/`

Tool actions are split by active vs compatibility concerns:

- `handlers/result.ts` — standard text result helper
- `handlers/coordination.ts` — join, status, list, send, reserve, release, whois, feed, status updates
- `handlers/legacy.ts` — spec-based compatibility actions retained for older flows

### `overlay/`

Overlay logic is split into controller helpers:

- `overlay/input.ts` — keyboard/input handling
- `overlay/feed-window.ts` — feed windowing, cache keys, viewport math
- `overlay/notifications.ts` — significant-event + completion-state helpers
- `overlay/snapshot.ts` — share/background snapshot generation
- `overlay/render-*.ts` — render-only helpers for list/feed/detail sections

### `extension/`

Extension runtime helpers extracted from `index.ts`:

- `extension/deliver-message.ts` — inbound message rendering/steering
- `extension/status.ts` — status-bar + unread/stuck state management
- `extension/activity.ts` — tool activity tracking, auto-status, edit/test/commit feed logging

## Compatibility strategy

Public imports still work through the root facades:

- `store.ts`
- `handlers.ts`
- `overlay-render.ts`

This keeps the extension behavior stable while allowing internal modules to evolve in smaller pieces.

## Testing focus

The refactor keeps a bias toward behavior-preserving changes. New tests were added around:

- legacy spec-claim compatibility
- message draining + watcher smoke behavior
- overlay snapshot and notification logic
- extracted overlay input behavior
- extracted activity tracking logic

When adding new features, prefer extending the focused internal modules and only touch the root facade/composition files when wiring is required.
