# TUI Integration Guide

The `fixate-on` provides a dual-mode system: a **server plugin**
that manages goal state and a **TUI companion plugin** that renders
interactive status panels, keyboard controls, and toast notifications.

## Architecture

**Which file loads what:** stock OpenCode v1 loads the server plugin from the
`opencode.json` `plugin` array and the TUI companion ONLY via the `tui.json`
`plugin` array (`~/.config/opencode/tui.json`, overridable with
`$OPENCODE_TUI_CONFIG`).
Registering the companion in `opencode.json` does not load it. With the
companion in `tui.json`, all 11 `Fixate:` palette entries of the v1 companion render
(palette filtered on `fixate:`; the v2 companion registers 13) with chord
hints shown on the six bound actions. One
caveat stands: the chords themselves are not byte-deliverable through
tmux/terminal (`ctrl+shift+g` arrives as `0x07`), so the palette — not the
chord — is the guaranteed path, and every live campaign in
`hack/e2e-harness/` drives the palette. The v1 companion therefore keeps
its slash + state-file surfaces first-class.

On opencode2 the server→TUI channel rides `tool Result.metadata`
(`tool Result.metadata` → `session.tool.success` → `context.data.on` → store),
not `client.tui.publish`. On stock v1 the transport is disk hydration +
a state-file refresh loop plus curated human-readable toasts — the publish
channel is never used as a data transport there (v1 renders every published
toast on screen, so data events would flood the UI).

```
OpenCode Host (v1: toast channel)

  Server Plugin (src/plugin.ts)          TUI Companion Plugin (src/tui.ts)
    - goal state                          - state store
    - state machine                       - dashboard formatter
    - persistence                         - keymap handlers
    - command hooks                       - toast manager
    - broadcaster
        |  publish
        v
  Host Event Bus (SSE): client.tui.publish() -> api.event.on("tui.toast.show")
```

## Installation

Register the server plugin in `opencode.json` and the TUI companion in `tui.json`
(the v1 loader reads them from different files — putting the companion in
`opencode.json` does not load it):

`opencode.json`:

```json
{
  "plugin": [
    "fixate-on"
  ]
}
```

`tui.json` (`~/.config/opencode/tui.json`, or `$OPENCODE_TUI_CONFIG`):

```json
{
  "plugin": [
    "fixate-on/tui"
  ]
}
```

The server plugin (`fixate-on`) manages goal state, persistence,
and the command execution loop. The TUI companion (`fixate-on/tui`)
subscribes to goal lifecycle events and renders interactive panels.

## Dual-Mode Command Execution

Slash commands (`/goal status`, `/goal history`, `/goal list`, etc.) operate
in two modes:

### TUI Mode (companion attached)

When the TUI companion is registered, the server plugin detects
`client.tui.publish` and sets the `hasTuiCompanion` flag. Command output
includes a header noting the interactive dashboard is available:

```
[TUI mode] /status
Active goal: fix the failing tests
Auto-continues sent: 3/10
Context tokens: 12,400/200,000
...
```

The TUI companion receives goal lifecycle events in real time via the host
event bus, maintaining a synchronized state store that powers the interactive
dashboard.

### Server Mode (headless / no TUI)

When no TUI companion is registered, commands produce plain-text output with
an explicit header indicating the output is routed to the model as a chat
turn:

```
[Server mode - output routed to model as chat turn] /status
Active goal: fix the failing tests
Auto-continues sent: 3/10
Context tokens: 12,400/200,000
...
```

This is the default behavior when running in headless/automated environments.

## Keyboard Shortcuts

The TUI companion registers two-key chords: the `ctrl+shift+g` prefix, then the
action key. The prefix is what keeps these out of the prompt's way.

| Chord              | Action      | Description                    |
|--------------------|-------------|--------------------------------|
| `ctrl+shift+g` `d` | Dashboard   | Show the status dashboard      |
| `ctrl+shift+g` `p` | Pause       | Pause the active goal          |
| `ctrl+shift+g` `r` | Resume      | Resume the paused goal         |
| `ctrl+shift+g` `c` | Clear       | Clear the active goal          |
| `ctrl+shift+g` `e` | Edit        | Edit the goal objective        |
| `ctrl+shift+g` `k` | Checkpoint  | Add a checkpoint               |

**The prefix is not universally deliverable.** On some terminals `ctrl+shift+g`
arrives as `0x07` and the chord never fires. The command palette
(`ctrl+p`, then type `fixate:`) reaches all six actions on every supported host,
and is the path every live campaign in `../hack` takes.

The `0x07` behaviour was recorded during product design. The prefix is unclaimed
in common emulators and still undeliverable on some terminals; both can be
true. The chord is an optimisation; the palette is the guarantee.

Keymaps are optional overrides — the user can interact via `/goal` commands
without ever touching a key (AGENTS.md Principle 4).

## State Synchronization

The server plugin publishes goal lifecycle events over
`pluginOptions.tuiTransport` — the v2 adapter's buffering channel, surfaced
through tool `Result.metadata`. That envelope carries a `fixate-on` marker the
companion filters on:

```json
{
  "fixate-on": { "events": [ { "kind": "transition", "goalId": "…", "snapshot": { } } ] }
}
```

`GOAL_TUI_METADATA_KEY` is the property name and `GOAL_TUI_EVENT_TITLE` is the
title used on the equivalent direct event envelope; both are the package name by
design, and both are defined once in `src/tui-state.ts`.

### On v1 hosts there is no event transport

The v1 `client.tui.publish` endpoint renders **every** published envelope as a
visible toast, so the server sends **no** data events on that channel — it is
contractually silent, and a test locks that. On a v1 host the companion instead
reads the persisted state file (`readDiskGoalSnapshots`) on a refresh loop
(`createDiskRefreshLoop`) and curates its own rare, human-readable toasts
(`tui-toast-policy.ts`). Live indicators still update; the source of truth is the
state file rather than an event stream.

This is why the architecture note above says the publish channel "is never used
as a data transport there". It is not a lesser path — it is the only path that
does not put JSON on a user's screen.

### Which moments reach the user

`createDiskRefreshLoop` synthesises an event per diff, and `tui-toast-policy.ts`
decides which of those are worth a line of text. The rule is the **working
boundary**: a moment that changes whether the goal is working.

| Moment | Announced |
|---|---|
| Goal created or cleared | yes |
| Started working — session resume, sequence auto-promote, resume after a brake | yes |
| Stopped working — stall, deferral, execution error, `/goal pause`, brake, complete, blocked | yes |
| Paused for your next message, and re-armed when your turn ends | no, either half |
| The plugin's own recovery pause while restoring a session | no |
| Every continuation of a goal that is already working | no |
| Token and turn accounting | no |

The two silent rows follow from the same rule. On every human message
`hooks.ts` pauses each active goal and the idle handler re-arms it, so the user
just spoke and the goal hands the turn straight back; announcing either half
produced two toasts per goal per message sent. The recovery pause is the
plugin's own bookkeeping during hydration. Both are recognised from the stop's
own `stopReason` — the companion sees the pause and remembers which goals are
mid-yield — so no producer had to change to tell a yield from a resume.

Telling "started" from "still working" needs the status the goal held *before*
the event. A running goal rewrites its persisted state on every turn, so
`status: active` alone cannot say whether the goal just started or is still
going. Both producers send that: the broadcaster as `previousStatus` alongside
its `transition`, and the disk loop from the snapshot it diffed against. An
event with neither is announced only when its snapshot states its own outcome —
`complete`, `blocked`, or a limit-class stop — because an `active` snapshot on
its own cannot distinguish an entry from a continuation, and guessing "entry" is
what a storm looks like.

`ToastCoalescer` sits between the policy and `ui.toast`. It enforces a 2 s
minimum interval, a 500 ms duplicate window and a bounded queue, **per
session** — a goal settling in one session of a workspace is not silenced by
another session's traffic. When one goal produces a second moment inside the
same window, the newer replaces the older in the queue: the newest state of a
goal is the only one worth saying. A toast already shown is not replaced,
because it cannot be un-shown, so a goal that stops and is resumed in separate
windows is reported twice — once for each thing that actually happened.

### On load

Hydration is silent about moments. A goal recovered from disk does not announce
itself as newly started, because you did not start it — and the refresh loop
refuses to take a baseline from a read that could see neither a state file nor a
state directory, so a state file caught mid-write cannot turn every running goal
into a fresh "Goal started". It is not silent about facts: after the companion's
first authoritative read it emits at most one summary naming how many goals in
the workspace are stopped and waiting on you, grouped by reason. Goals that
resume on their own — `recovery`, `user intervention`, `queued` — are excluded,
because the boundary announcement already covers them. The exclusion for
`user intervention` is conditional: the pause is a promise that the plugin
will re-arm the goal when your turn ends, and on a host that delivers no idle
events the poller is the only thing that can keep that promise. The poller
can refuse — the newest message is yours and no reply has arrived, the reply
carries no id, or the turn never reports itself settled — and each refusal is
correct, because a gate that stops a continuation being injected into a live
turn is protecting against a worse harm than a goal that waits.

So a yield past `YIELD_PROMISE_MS` (15 minutes, read from the goal's own
persisted clock so a restart cannot forgive it) stops being counted as
self-resolving. It briefs as "it did not pick your message back up", the card
reads `did not re-arm` rather than `re-arms automatically`, and `/goal status`
offers a resume. A yield inside its window is unchanged, which is the half that
matters: the exclusion exists so a goal about to resume is not announced as
though it needed you.

### Event Types

| Kind         | Trigger                    | Payload           |
|--------------|----------------------------|-------------------|
| `create`     | Goal created               | Snapshot          |
| `transition` | Status change (pause/resume/complete/block) | Snapshot + `previousStatus`; the server broadcaster also sends `transition` |
| `usage`      | Token/turn count updated   | Snapshot          |
| `remove`     | Goal deleted               | goalId only       |

### Resilience

- **Broadcaster failures are swallowed** — a TUI disconnect cannot break the
  state machine.
- **Revision monotonicity** — stale events (lower revision) are ignored for
  existing goals.
- **Late subscribers hydrate** from the store's current state (no event
  replay needed), and on v1 from the state file on disk.
- **Snapshots are frozen** — the TUI render layer cannot mutate shared state.
- **A disk refresh that races a write** is a read of a partially written file,
  not a crash: the next tick re-reads.

### Display lag and the staleness floor

The file-sourced dashboard does not show live memory; it shows the last state
file the server persisted, read on a poll. Three numbers bound how stale that
can be, and they are stated here because the acceptance for state alignment
requires the lag documented with numbers rather than left implicit.

- **Usage-only churn does not move the gauge.** `updateUsage`
  (src/state-machine.ts, `updateUsage`) mutates the in-memory state and deliberately skips
  persistence: "No onCommit — usage updates are frequent; persistence happens on
  the next semantic transition" (the comment on `updateUsage` in src/state-machine.ts). The dashboard reads
  `totalTokens` from the state file (src/tui-views.ts), so during a long
  turn that produces only token churn the gauge stays where the last semantic
  persist left it. It moves on the next pause/resume/edit/checkpoint or any
  lifecycle transition. That lag is by design, not a defect; the alternative is a
  disk write per usage event.
- **Staleness floor.** A state-file change reaches the dashboard within one
  refresh poll, default 1000 ms (`intervalMs` in src/tui-companion-refresh.ts). A lifecycle
  moment reaches a toast within that poll plus the coalescer's 2000 ms
  minimum-interval gate (`TOAST_MIN_INTERVAL_MS` in src/tui-toast-policy.ts), with a 500 ms
  duplicate-suppression window. So the floor is roughly 1 s for the dashboard
  and up to 3 s for a toast after a persist.
- **A WAL-durable removal with a failed snapshot.** `removeGoalOwned`
  (src/session-lifecycle.ts) appends a durable removal tombstone to the
  ledger, sets the invalidation fence, then persists the snapshot. If that
  snapshot write fails, the
  on-disk state file still lists the goal, and the fence marker is retained
  (`pendingInvalidationCheckpoints`, held by SessionStateManager in
  src/session-state-manager.ts) rather
  than released. Two things keep this honest: the live removal is broadcast
  immediately (`broadcaster.emitRemove`), so
  the in-memory store drops the goal at once; and the fence's
  `invalidatedGoalIds` is written into the next durable snapshot, so recovery and
  any later read treat the goal as removed — it cannot be resurrected or driven.
  The v1 companion reads snapshots only, never the ledger, so between a failed
  snapshot and the next successful persist there is a bounded window where the
  disk-sourced dashboard can still show the goal; the fence, not the display, is
  the guarantee, and it holds.

## Module Structure

| Module | Role | Project dependencies |
|---|---|---|
| `src/tui-state.ts` | Snapshot projection, event contract, in-process store (leaf) | `accounting.ts`, `state-machine.ts` |
| `src/tui-components.ts` | Toast helpers + `PRODUCT_DISPLAY_NAME` (leaf) | None |
| `src/tui-views.ts` | Dashboard formatter (pure) | `brake-format.ts`, `status-label.ts`, `tui-analytics.ts`, `tui-components.ts`, `tui-state.ts` |
| `src/tui-dashboard-route.tsx` | Host-native full-screen dashboard route | `tui-components.ts`, `tui-state.ts`, `tui-views.ts` (the card's text comes from `goalCardLines`, which is what makes the attribution and the brake ceiling testable without the host's terminal renderer) |
| `src/tui-toast-policy.ts` | Which store moments deserve a visible toast | `status-label.ts`, `tui-components.ts`, `tui-state.ts`, plus the `GoalStatus` type from `state-machine.ts` |
| `src/tui-action-labels.ts` | Outcome-neutral palette labels and watchdog hints | `tui-components.ts` |
| `src/tui-analytics.ts` | Cost per turn, burn rate, ETA projection (pure) | `accounting.ts`, `tui-components.ts`, `tui-state.ts` |
| `src/tui-sound.ts` | Lifecycle event to attention-sound name (pure) | `state-machine.ts`, `tui-state.ts` |
| `src/tui-disk-state.ts` | Enumerates and reads every session's persisted goal state | `fs-portable.ts` (the bounded, symlink-refusing read), `session-paths.ts` (the layout), `state-machine.ts`, `tui-state.ts` |
| `src/tui-companion-refresh.ts` | v1 disk refresh loop | `tui-disk-state.ts`, `tui-state.ts` |
| `src/tui.ts` | v1 TUI companion entrypoint | `tui-action-labels.ts`, `tui-companion-refresh.ts`, `tui-components.ts`, `tui-disk-state.ts`, `tui-sound.ts`, `tui-state.ts`, `tui-toast-policy.ts`, `tui-views.ts`, plus `@opencode-ai/plugin` and `@opencode-ai/plugin/tui` |
| `src/tui-v2.ts` | v2 TUI companion entrypoint | `tui-action-labels.ts`, `tui-components.ts`, `tui-dashboard-route.tsx`, `tui-disk-state.ts`, `tui-state.ts`, `tui-v2-events.ts`, `tui-views.ts` |
| `src/tui-v2-events.ts` | v2 event-driven truth channels: disk-refresh loop, curated toasts, briefing, tool-metadata subscription | `state-machine.ts`, `tui-action-labels.ts`, `tui-companion-refresh.ts`, `tui-components.ts`, `tui-sound.ts`, `tui-state.ts`, `tui-toast-policy.ts` |

## Host API Requirements

- **OpenCode** >= 1.17.18
- **`@opencode-ai/plugin`** >= 1.17.18 < 2
- The host client should expose `ui.toast` / `ui.dialog`. Absent those, the
  companion still tracks state and the dashboard, it just cannot show anything.
- **`tui.publish` is not a data transport and never was** — see
  [On v1 hosts there is no event transport](#on-v1-hosts-there-is-no-event-transport).
  The v2 companion's data channel is the `tuiTransport` option; the v1
  companion's is the state file.
