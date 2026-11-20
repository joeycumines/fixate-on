# TUI Integration Guide

The `fixate-on` provides a dual-mode system: a **server plugin**
that manages goal state and a **TUI companion plugin** that renders
interactive status panels, keyboard controls, and toast notifications.
The slash-command and goal-tool surface these panels drive is documented in
the [README's command reference](../README.md#goal-command-reference); this
guide covers only the companion's own behavior — see
[Installation](#installation), [Keyboard Shortcuts](#keyboard-shortcuts), and
[State Synchronization](#state-synchronization).

## Architecture

**Which file loads what:** stock OpenCode 1.x loads the server plugin from the
`opencode.json` `plugin` array and the TUI companion ONLY via the `tui.json`
`plugin` array (`~/.config/opencode/tui.json`, overridable with
`$OPENCODE_TUI_CONFIG`).
Registering the companion in `opencode.json` does not load it. With the
companion in `tui.json`, all 11 `Fixate:` palette entries of the 1.x companion render
(palette filtered on `fixate:`; the 2.x companion registers 13 palette entries
plus 4 dashboard-only scroll commands) with chord
hints shown on the six bound actions. One
caveat stands: the chords themselves are not byte-deliverable through
tmux/terminal (`ctrl+shift+g` arrives as `0x07`), so the palette — not the
chord — is the guaranteed path, and every live campaign in
`hack/e2e-harness/` drives the palette. The 1.x companion therefore keeps
its slash + state-file surfaces first-class.

On OpenCode 2.x goal state rides `tool Result.metadata`
(`tool Result.metadata` → `session.tool.success` → `context.data.on` → store),
and native command receipts use a separate passive RPC event channel. Neither
uses `client.tui.publish`. On stock 1.x the transport is disk hydration +
a state-file refresh loop plus curated human-readable toasts — the publish
channel is never used as a data transport there (1.x renders every published
toast on screen, so data events would flood the UI).

```
OpenCode 1.x (toast channel)

  Server Plugin (src/plugin.ts)          TUI Companion Plugin (src/tui.ts)
    - goal state                          - state store
    - state machine                       - dashboard formatter
    - persistence                         - keymap handlers
    - command hooks                       - toast manager
    - broadcaster
        |  publish
        v
  OpenCode event bus (SSE): client.tui.publish() -> api.event.on("tui.toast.show")
```

## Installation

OpenCode 1.x (`opencode`) and 2.x (`opencode2`) each read a different file, and each loads a different companion entrypoint:

| File | Read by | Holds |
|:---|:---|:---|
| `opencode.json` | 1.x server | the server plugin (`plugin` array) |
| `tui.json` (`~/.config/opencode/tui.json` or `$OPENCODE_TUI_CONFIG`) | 1.x TUI only | the 1.x companion (`fixate-on/tui`); putting it in `opencode.json` does not load it |
| `cli.json` | 2.x TUI | the 2.x companion, loaded through a directory adapter (see [Installation](#installation)) |
| `opencode.json` (`plugins`) | 2.x server | the server plugin (`{package, options}` entries; released 2.x builds require a directory for local paths) |

**OpenCode 1.x**: server plugin in `opencode.json`, companion in `tui.json`:

`opencode.json`:

```json
{
  "plugin": [
    "fixate-on"
  ]
}
```

`tui.json`:

```json
{
  "plugin": [
    "fixate-on/tui"
  ]
}
```

**OpenCode 2.x**: server plugin in `opencode.json` under `plugins`, companion in `cli.json`:

`opencode.json`:

```json
{
  "plugins": [
    { "package": "file:///absolute/path/to/plugin-wrappers/fixate-on", "options": { "stateRoot": ".opencode/goals" } }
  ]
}
```

`cli.json` (the companion uses the same directory adapter; a bare `fixate-on/tui-v2` package spec is parsed as GitHub shorthand, and a direct `file://` URL to a `tui-v2.js` file is skipped by the 2.x TUI loader):

```json
{
  "plugins": [
    { "package": "file:///absolute/path/to/plugin-wrappers/fixate-on", "options": { "stateRoot": ".opencode/goals" } }
  ]
}
```

For a local checkout on 2.x, released builds reject a configured plugin **file** target (`configured plugin path must be a directory`), so point at a small adapter directory that re-exports the bundles: `server.js` re-exporting `plugin/fixate-on/plugin.js`, `tui.js` re-exporting `plugin/fixate-on/tui-v2.js` (not the package's `./tui`, which is the 1.x companion). `hack/e2e-harness/plugin-dir/` in this repository is a working copy. The same directory target is used in both `opencode.json` and `cli.json`; a `file://` URL pointing directly at `tui-v2.js` is not loaded by the 2.x TUI. The full recipes, including the shared-config variant that serves both versions from one `opencode.json`, are in [the README's installation section](../README.md#loading-from-local-source).

With the pair in place, smoke-test the pairing:

```sh
# from a session running the server plugin, in the TUI companion:
/goal status          # on 2.x, the companion displays the full receipt in a dialog
/goal list all         # the dashboard mirrors this list within one refresh poll
```

The server plugin (`fixate-on`) manages goal state, persistence,
and the command execution loop. The TUI companion (`fixate-on/tui` on 1.x,
the v2 companion on 2.x) subscribes to goal lifecycle events and renders
interactive panels. Set the identical `stateRoot` option (or
`FIXATE_ON_STATE_ROOT`) on the server entry and the companion entry: on 2.x
they resolve the root independently and host discovery may strip entry options,
so one entry alone is not enough; on 1.x they are two entries in two files and
must agree. Confirm the pairing with `/goal status`.

## Dual-Mode Command Execution

Slash commands (`/goal status`, `/goal history`, `/goal list`, etc.) operate
in two modes:

### TUI Mode (companion attached)

The command dispatcher labels receipts `[TUI mode]` when a TUI transport is
configured. On 2.x the server's buffering transport supplies this capability;
the header is not a handshake confirming that a companion is connected. Confirm
the pairing by observing the receipt dialog and dashboard update. A receipt
has this form:

```
[TUI mode] /status
Active goal: fix the failing tests
Auto-continues sent: 3/10
Context tokens: 12,400/200,000
...
```

The TUI companion receives goal lifecycle events in real time via the OpenCode
event bus, maintaining a synchronized state store that powers the interactive
dashboard.

### Server Mode (headless / no TUI)

On the 1.x command path, when no TUI companion is registered, commands produce plain-text output with
an explicit header indicating the output is routed to the model as a chat
turn:

```
[Server mode - output routed to model as chat turn] /status
Active goal: fix the failing tests
Auto-continues sent: 3/10
Context tokens: 12,400/200,000
...
```

On 2.x, the `goal-command` tool returns text in its tool result. The native
`/goal` command instead uses the passive receipt channel below, including in
headless environments.

### Passive command receipts on 2.x

The server registers the `fixate-on-output` RPC. Its `output` event carries
`{id, sessionID, text, kind, timestamp}`; `kind` is `command` or `notice`.
The v2 companion subscribes through the host's reconnecting
`context.data.on('rpc.fixate-on-output.output', ...)` event feed. It requests the
latest receipt for the open session at startup and after `server.connected`;
a delayed replay cannot replace a newer live receipt. Repeated receipt IDs are
ignored.

For the open session, command receipts use a scrollable dialog that keeps the
full text available as the terminal resizes. Use `up`/`down`,
`pageup`/`pagedown`, `home`/`end`, or the mouse wheel to scroll; `escape` or
`enter` closes the viewer. Other sessions and notices use session-scoped toasts.
Command receipts never call `session.prompt` or `session.synthetic`: both admit
model input on the verified OpenCode v2.2.7 host.

A headless client can consume the event `rpc.fixate-on-output.output` on the
host's event stream. After a missed event it can request the latest receipt:

```http
POST /api/rpc/fixate-on-output/latest
Content-Type: application/json

{"input":{"sessionID":"ses_example"}}
```

The response is `{"output": <receipt or null>}`. The server retains one receipt
per session, up to 256 sessions, for its current process lifetime. This is a
display channel, not a persisted transcript. The TUI companion is required for
automatic display of native command receipts; a server-only client must consume
the event or the RPC result itself. Hosts without RPC can supply `goalMessenger`.
With neither channel available, the native command reports an explicit delivery
error containing the completed command's result, rather than silently losing it.

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

**Dashboard scrolling (2.x):** while the goal dashboard is open, `up`/`down`
scroll one line and `pageup`/`pagedown` scroll half a page (the four
`fixate-on.scroll.*` commands; they stay disabled — and do not shadow the
host's own arrow/page keys — whenever the dashboard is closed).

**The prefix is not universally deliverable.** On some terminals `ctrl+shift+g`
arrives as `0x07` and the chord never fires. The command palette
(`ctrl+p`, then type `fixate:`) reaches all six actions on every supported OpenCode version,
and is the path every live campaign in `../hack` takes. Every palette action has
an equivalent slash command in the [README's subcommand table](../README.md#subcommands)
— for example the pause chord mirrors `/goal pause`, the clear chord mirrors
`/goal clear`.

The `0x07` behaviour was recorded during product design. The prefix is unclaimed
in common emulators and still undeliverable on some terminals; both can be
true. The chord is an optimisation; the palette is the guarantee.

Keymaps are optional overrides — the user can interact via `/goal` commands
without ever touching a key (AGENTS.md Principle 4).

## State Synchronization

The server plugin publishes goal lifecycle events over
`pluginOptions.tuiTransport` — the 2.x adapter's buffering channel, surfaced
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

### On OpenCode 1.x there is no event transport

The 1.x `client.tui.publish` endpoint renders **every** published envelope as a
visible toast, so the server sends **no** data events on that channel — it is
contractually silent, and a test locks that. On 1.x the companion instead
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
will re-arm the goal when your turn ends, and on a version that delivers no idle
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
  replay needed), and on 1.x from the state file on disk.
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
  The 1.x companion reads snapshots only, never the ledger, so between a failed
  snapshot and the next successful persist there is a bounded window where the
  disk-sourced dashboard can still show the goal; the fence, not the display, is
  the guarantee, and it holds.

## Module Structure

| Module | Role | Project dependencies |
|---|---|---|
| `src/tui-state.ts` | Snapshot projection, event contract, in-process store (leaf) | `accounting.ts`, `state-machine.ts` |
| `src/tui-components.ts` | Toast helpers + `PRODUCT_DISPLAY_NAME` (leaf) | None |
| `src/tui-views.ts` | Dashboard formatter (pure) | `brake-format.ts`, `status-label.ts`, `tui-analytics.ts`, `tui-components.ts`, `tui-state.ts` |
| `src/tui-dashboard-route.tsx` | OpenCode-native full-screen dashboard route | `tui-components.ts`, `tui-state.ts`, `tui-views.ts` (the card's text comes from `goalCardLines`, which is what makes the attribution and the brake ceiling testable without OpenCode's terminal renderer) |
| `src/tui-toast-policy.ts` | Which store moments deserve a visible toast | `status-label.ts`, `tui-components.ts`, `tui-state.ts`, plus the `GoalStatus` type from `state-machine.ts` |
| `src/tui-action-labels.ts` | Outcome-neutral palette labels and watchdog hints | `tui-components.ts` |
| `src/tui-analytics.ts` | Cost per turn, burn rate, ETA projection (pure) | `accounting.ts`, `tui-components.ts`, `tui-state.ts` |
| `src/tui-sound.ts` | Lifecycle event to attention-sound name (pure) | `state-machine.ts`, `tui-state.ts` |
| `src/tui-disk-state.ts` | Enumerates and reads every session's persisted goal state | `fs-portable.ts` (the bounded, symlink-refusing read), `session-paths.ts` (the layout), `state-machine.ts`, `tui-state.ts` |
| `src/tui-companion-refresh.ts` | v1 disk refresh loop | `tui-disk-state.ts`, `tui-state.ts` |
| `src/tui.ts` | v1 TUI companion entrypoint | `tui-action-labels.ts`, `tui-companion-refresh.ts`, `tui-components.ts`, `tui-disk-state.ts`, `tui-sound.ts`, `tui-state.ts`, `tui-toast-policy.ts`, `tui-views.ts`, plus `@opencode-ai/plugin` and `@opencode-ai/plugin/tui` |
| `src/tui-v2.ts` | v2 TUI companion entrypoint | `tui-action-labels.ts`, `tui-components.ts`, `tui-dashboard-route.tsx`, `tui-disk-state.ts`, `tui-state.ts`, `tui-v2-command-output.ts`, `tui-v2-events.ts`, `tui-v2-receipt-dialog.tsx`, `tui-views.ts` |
| `src/tui-v2-command-output.ts` | Passive native command receipts and notices | `plugin-v2-command-output.ts`, `tui-components.ts` |
| `src/tui-v2-receipt-dialog.tsx` | Scrollable native command receipt viewer | `tui-dashboard-route.tsx`, `tui-components.ts`, host Solid/OpenTUI modules |
| `src/tui-v2-events.ts` | v2 event-driven truth channels: disk-refresh loop, curated toasts, briefing, tool-metadata subscription | `state-machine.ts`, `tui-action-labels.ts`, `tui-companion-refresh.ts`, `tui-components.ts`, `tui-sound.ts`, `tui-state.ts`, `tui-toast-policy.ts` |

The bundle script (`scripts/bundle.ts`) applies the OpenTUI Solid compiler to
JSX before bundling. This preserves reactive theme colors, dashboard state, and
receipt layout on resize; plain JSX compilation does not provide those updates.
Solid and OpenTUI remain external modules supplied by the 2.x host.

## Host API Requirements

Here "host" means the OpenCode process the plugin runs inside, whichever version it is.

- **OpenCode** >= 1.17.18
- **v1 server plugin:** `@opencode-ai/plugin` >= 1.17.18 < 2 (the 1.x peer SDK). The 2.x path does not import it; the published bundle's default export is the 2.x `{ id, setup }` plugin, which is why `package.json`'s `engines.opencode` range (`<2`) describes the 1.x peer dependency only.
- **v1 companion:** `@opencode-ai/plugin/tui` from the same 1.x SDK range.
- **2.x companion (`./tui-v2`):** host-supplied modules; no package dependency.
- The OpenCode client should expose `ui.toast` / `ui.dialog`. Absent those, the
  companion still tracks state and the dashboard, it just cannot show anything.
- **Released 2.x builds (measured on installed v2.2.7, the binary this repo's e2e harness runs; earlier releases through v2.2.5 behaved worse):** the server rejects a configured plugin **file** target with `configured plugin path must be a directory` on every 2.x release, and on v2.2.7 the TUI loads `cli.json` plugins (including `file://` URLs) and registers their palette entries. Releases through v2.2.5 never registered CLI-plugin palette entries; those fixes exist in 2.x source from commits `0dfcb30d71` and `359c501ceb`. To stay safe across builds, install from npm or use an adapter directory, and keep `file://` entries for v2.2.7+ only.
- **The v2 companion must declare its keymap layer `mode: "global"`.** OpenCode 2.x filters command reachability by the active input mode, and the command palette pushes its own mode — a base-mode layer's entries vanish from the palette the moment it opens. Releases through v2.2.5 default plugin layers to base mode (upstream's global-mode default, commit `359c501ceb`, shipped in later releases such as v2.2.7), so the companion sets the mode itself (`src/tui-v2.ts`); a regression test pins it.
- **`tui.publish` is not a data transport and never was** — see
  [On OpenCode 1.x there is no event transport](#on-opencode-1x-there-is-no-event-transport).
  The v2 companion's data channel is the `tuiTransport` option; the v1
  companion's is the state file. The companion reads goal state written by the
  server plugin — the same state behind [`/goal list all`](../README.md#subcommands)
  and [`/goal status --full`](../README.md#subcommands).
