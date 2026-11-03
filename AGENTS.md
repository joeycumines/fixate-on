# AGENTS.md

This repository uses **`bun`** as the sole JavaScript/TypeScript runtime and test
runner. **Never use `node` to execute scripts or tests.** Use `bun` for every
command that would otherwise invoke `node`.

`npm`/`node` must not be used to run the project. The `package.json` scripts are
bun-compatible; invoke them with `bun run <script>`. The published runtime target
is bun (`bun build` produces the plugin bundle in `plugin/fixate-on` and is run
like `bun run bundle`).

One exception: **`gts` is a Node-based tool.** `gts lint` and `gts fix` shell
out to `eslint` and print a Node version banner, and they are still how this
repository is linted. That is a property of the tool, not of the project.

Dependencies are declared for the bun toolchain. Do not introduce `node`-only
assumptions. Source is TypeScript (`.ts`); bun runs `.ts` natively for tests and
`bun build` compiles the bundle. The bun version is pinned in `packageManager`;
CI reads it from the same place. Install with `bun install --frozen-lockfile` so
a stale lockfile fails loudly rather than being rewritten in place.

Tests must be hermetic. A test that reads persisted goal state must pass an
explicit `directory` — `hydrateStoreFromDisk` otherwise falls back to
`process.cwd()` (`src/tui-disk-state.ts`), silently reading the developer's own
untracked `.opencode/goals/sessions/<sessionID>/state.json`, so it passes
locally and fails on a clean checkout.

`bun pm pack` and `bun publish` run **no** lifecycle scripts, and the generated
bundle is gitignored, so a pack performed before `bun run bundle` produces a
tarball that cannot load. Always run `bun run bundle` before packing; never
rely on remembering to bundle first.

On OpenCode v2 hosts, `/goal` only reaches goal state when `command.goal`'s
template routes through the plugin's `goal-command` tool — see the README's
"`/goal` on OpenCode v2 hosts" section before touching command wiring.

## Vocabulary (authoritative — use these words everywhere)

One set of terms, applied universally: code identifiers, exported types, docs,
comments, user-facing strings, and tests. If a concept is not below, name it
with a word that already is.

- **goal** — the objective the user stated, in their words. A session may hold
  several.
- **continuation** — a loop turn driven by the plugin, not by the user.
- **claim** — an agent's statement about state; above all, "this is done".
- **verifier** — something that checks a claim. Two kinds: a **command
  verifier** (a program run, its exit status observed) and a **judge** (a model
  asked whether the claim holds). Neither outranks the other; both are fallible.
- **attestation** — a verifier's finding on a claim, naming which verifier and
  citing its evidence.
- **attested** — a completion claim that carries an attestation.
- **fault** — an operational failure to *obtain* an attestation. Not a verdict
  about the goal; it is retried.
- **settle** — to take a goal to a terminal state.
- **brake** — a mechanical bound that stops a continuation. A budget is not a
  verdict.
- **session-scoped** — belonging to exactly one session, and to no other. A goal
  is session-scoped: forking a session **copies** its live goals and mints a new
  `goalId` for each, the parent keeps its own, and sharing one goal across two
  sessions is rejected outright (`fork-bind.ts`). This is a property of storage
  as much as of memory — a goal's persisted state lives in the file of the
  session that owns it, and no process writes another session's file. That is
  what lets two OpenCode processes share one worktree without either losing its
  goal tools, rather than one of them being locked out.

Banned, because they assert a certainty that does not exist: *proven*,
*verified-complete*, *promised*, *oracle*, *classifier*, *auditor* (as synonyms
of verifier), *safety stop*, *load flake*. A command check is a fallible
attestation by another means — a make target can be edited by the model, a test
rewritten, a command's meaning changed underneath it. There is no ranking
between verifiers, and no term for one.

## Ways of working

**Kaizen (改善).** Continuous improvement, in small increments, from the bottom
up. The implementing agent is expected and empowered to notice and fix small
inefficiencies in passing rather than asking permission for them — and to
**standardise** an improvement that proves out so it applies everywhere, rather
than leaving it local. A fix that helps once and is not generalised is unfinished
work. This is a way of working, not a slogan: prefer many small verified
improvements over one sweeping reform, and never let a known defect stand
because it is small.

**Empirical evidence over argument.** Whether a goal implementation is
*effective* cannot be settled by reasoning alone. Claims about behaviour —
especially about what makes a loop terminate, continue, or stall — are settled by
**measurement**, and the test suite is the instrument: when behaviour changes, add
or update a test and report the result. A behavioural claim without a
measurement is an opinion, and must be labelled as one.

**Read the OpenCode source, not just the plugin.** When plugin behaviour cannot be explained from this repository alone, reconstruct the incident from the host's own persisted records and cross-reference the OpenCode host source at the exact version in use, rather than diagnosing a plugin↔host interaction bug from symptoms or documentation. If you don't have the source available, ask the user.

## Design principles

1. **Mechanically enforce behavioral invariants.** If a rule matters (a
   turn threshold, a gating condition, a state-machine constraint), enforce it
   in code with tracked state — not in prompt text alone. Prompt instructions
   are advisory; the system must guarantee the invariant. When porting a
   reference implementation, if the reference relies on prompt-only rules,
   decide explicitly whether that is acceptable for this plugin or whether a
   mechanical counter/gate is needed, and document the decision.

2. **Surface decisions and state transitions to the user.** Judge verdicts,
   blocker reports, threshold progress, and other meaningful state changes
   must be visible in the conversation — not only in logs, state files, or
   internal history. If the host does not render hook output, inject the
   information into the next continuation prompt's context. A user watching
   the session must be able to see what the plugin decided and why.

3. **Keep naming and documentation vendor-neutral.** This plugin runs on
   OpenCode, which supports many providers — not just OpenAI Codex. Token
   accounting, status models, and other cross-cutting concepts should be named
   and documented generally. If a formula or model happens to match a specific
   vendor's implementation, name the function/concept by what it *does*
   (e.g. `chargedTokens`), not by which vendor it came from. Vendor names may
   appear in comments citing provenance, but must not leak into public
   function names, exported types, user-facing docs, or the conceptual framing
   of the feature.

4. **Natural language is the primary interface; flags are overrides, never
   requirements.** The plugin must work from a plain-language goal objective
   with zero flags. Completion criteria, loop behavior, and exit conditions
   are expressed in the goal text itself and enforced mechanically — never
   gated behind a flag that the user must remember. Plugin-level options and
   per-goal flags may exist as optional overrides, but no normal use case
   should require them. The user writes `/goal fix the tests` and the loop
   drives itself; the user does not write `/goal fix the tests --success
   "tests pass" --max-completion-rejections 5`.

5. **Prevent premature exits AND let a finished goal end.** State determines
   whether a terminal transition is valid; the host adapter determines whether
   that transition can be blocked or repaired. Language only decides whether to
   inspect state more urgently. Two failure modes matter equally, and the second
   is not a lesser evil — it is the same defect in reverse:

   - **Premature exit.** An agent claiming completion that the work does not
     support. This is why completion is checked at all.
   - **A goal that cannot end.** Refusing to settle when no proof exists keeps a
     goal alive forever. Measured: a successful session that released software
     and proved it still looped for ~594k tokens, and the only terminal action
     left to the agent was to declare finished work *blocked* — i.e. the design
     forced it to lie in order to stop. Refusing to settle is not safety; it is a
     hang with a justification attached.

   Every completion claim is checked by a **verifier**. A command verifier is an
   optimisation the *agent* may define and register when a requirement calls for
   it — never a flag the user must supply. A **judge** (a model asked to
   *falsify* the claim) is always available. A judge's concurrence is weak
   evidence and its refusal is strong, so the policy is asymmetric: easy to
   continue, hard to settle. Phrase triage (`src/stop-guard.ts`) is advisory,
   abstains, and CANNOT override a verifier. An operational failure to obtain an
   attestation is a **fault**: retried with backoff, never converted into a
   verdict about the goal, and bounded — after which the goal settles with an
   explicit receipt rather than looping. Recovery is bounded by BOTH a total
   budget (default 12) AND a consecutive-unchanged heuristic (default 3,
   comparing candidate+fingerprint). See `src/completion-gate.ts`,
   `src/stop-guard.ts`.

## File structure

- **TypeScript only.** All source is `.ts`, plus one `.tsx` (the host-native dashboard route, which the host renders as JSX). No `.js` source files.
- **No barreling.** Do not create `index.ts` files that re-export from other
  modules. Each file is an individual module; imports go directly to the
  defining file. This keeps dependency graphs explicit and prevents circular
  import cycles hidden behind a barrel.
- **Target ~900 lines per file.** Files should be cohesive — one concern per
  file. When a file exceeds ~900 lines, look for a seam (a boundary where one
  concern ends and another begins) and split.
- **Determine seams by dependency analysis.** Before creating a file, ask:
  what depends on what? What are the bits and how do they connect? Files
  should have clear, minimal dependency surfaces. A module that imports from
  5 other modules is probably doing too much.
- **No circular dependencies.** If module A imports from B and B imports from
  A, extract the shared dependency into a third module C that both import
  from. Use dependency-direction analysis (types → accounting → state-machine
  → persistence → steering → tools/commands → continuation-loop → hooks →
  plugin) to ensure the graph is a DAG.
- **File naming.** Name files after their primary concern. Test files are
  `<module>.test.ts` colocated in `test/`.
