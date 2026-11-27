# Verifier transport validation

The child verifier reads a model's final verdict only after its execution has
successfully settled. This checks the transport and execution boundary; a model's
finding remains a fallible attestation about the user's work.

## Host contract

OpenCode 2.2.7 returns an inbox admission from `session.prompt`. Its `session.wait`
returns when execution becomes idle, including failed and interrupted executions.
The plugin therefore requires all of the following before reading a verdict:

- The returned admission ID belongs to the child and occurs in fresh persisted
  context. A later user input supersedes that verification.
- A final assistant after that input finishes with `stop`, has a completion time,
  and names the requested verifier agent. It must contain the verdict itself;
  empty final replies cannot fall back to an earlier assistant.
- A durable `idle` row after the assistant has outcome `succeeded`. Failed or
  interrupted execution is a fault even if the assistant text is valid JSON.
- A subsequent session read reports the same successful settlement. Its busy and
  idle timestamps must agree with the completed response and the context's idle
  history. The host advances its idle timestamp by at least one millisecond per
  terminal event; validation preserves that rule for same-millisecond events.
- Child cleanup completes before returning an attestation.

The adapter reads persisted context, never its pre-turn message buffer, for this
decision. A host missing admission identity, context, completion wait, or the
durable settlement fields cannot provide this attestation and produces a fault.
The deadline still bounds the caller when a host operation hangs; late creation
and cleanup retain their existing ownership and reporting behavior. Monotonic
deadline checks also reject a result when a synchronous host operation blocks the
event loop beyond the limit before its timer can fire, including during cleanup.
The plugin cannot preempt such synchronous host code; it refuses a late
attestation once control returns.

OpenCode 1.x uses its synchronous prompt-response contract. Older responses that
contain only completed text or parts remain supported. When a response includes
an explicit finish reason, only `stop` is accepted; error, truncated, tool-call,
filtered, and unknown finishes cannot attest retained text. Errors at either the
response or assistant-info level remain faults.

If a host creates a child without preserving its requested parent, the adapter
rejects it and attempts deletion. A failed deletion reports the orphan's ID and
the original cleanup error, including when creation finishes after the caller's
deadline. A typed not-found error for that exact ID establishes that it is gone.
No client can force deletion while the host's deletion operation remains broken.

## Deterministic regression tests

Run with the repository's pinned Bun version:

```sh
bun test test/verifier-settlement.test.ts test/child-session-response.test.ts \
  test/verifier-orphan-cleanup.test.ts test/verifier-fresh-context.test.ts \
  test/child-session-cleanup.test.ts test/verifier-admission-policy.test.ts \
  test/child-session-verifier.test.ts test/plugin-v2-verifier-selection.test.ts \
  test/plugin-v2-tool-schema.test.ts test/session-api.test.ts \
  test/verifier-permissions.test.ts
```

These tests cover stale successful context, newer or interrupted executions,
missing admission identity, empty final replies, wrong-agent output, explicit
non-final finish reasons, legacy response compatibility, bounded cancellation,
permission refresh, and cleanup receipts. Operational `approve` policy returns
`WORKING` for the structured verifier; these faults never synthesize `COMPLETE`.

## Real-host fixture

```sh
OPENCODE_BINARY=/absolute/path/to/opencode-v2.2.7 \
  bun hack/verify-verifier-context.ts
```

The fixture launches an isolated official host with a local controlled provider,
fresh configuration and state directories, and a temporary git workspace. It
does not call a paid model provider or use the user's project state. The real
host performs session admission, agent selection, permissions, read tools,
execution settlement, context reads, and deletion.

| Case                                               | Persisted final text            | Host outcome | Required verifier result |
| -------------------------------------------------- | ------------------------------- | ------------ | ------------------------ |
| Final incomplete finding after a read              | `WORKING`                       | `succeeded`  | `WORKING`                |
| Final complete finding after a read                | `COMPLETE`                      | `succeeded`  | `COMPLETE`               |
| Fresh context read fails                           | `WORKING`                       | `succeeded`  | Fault                    |
| Three output-limit responses exhaust continuations | `COMPLETE`, finish `length`     | `failed`     | Fault                    |
| Next-step preparation fails after a tool step      | `COMPLETE`, finish `tool-calls` | `failed`     | Fault                    |
| Idle hook fails after the final response           | `COMPLETE`, finish `stop`       | `failed`     | Fault                    |

Each case separately inspects the host's persisted execution outcome, records
the actual and buffered responses, checks the available read-only tools and
permission update, and requires `GET` of the deleted child to return 404.
The script prints its evidence directory and writes one JSON observation per
case plus host logs and an aggregate result. It shuts down only its own host and
provider. The separate `hack/verify-child-permissions.ts` fixture checks real
permission denials; `hack/verify-child-session.ts` checks basic child lifecycle.

The supported contract was checked against [OpenCode 2.2.7 source at
`fedc6f208aa2bd54c1019227214568083f6380ad`](https://github.com/anomalyco/opencode/tree/fedc6f208aa2bd54c1019227214568083f6380ad/packages/core/src/session): the session prompt/inbox adapter,
execution coordinator, runner, message updater, and session projector. In
particular, `session/projector.ts` records the durable session outcome and
monotonic idle timestamp; `session/message-updater.ts` appends the corresponding
idle marker. Revalidate this boundary when adopting a host with different
settlement fields or timestamp rules.

The [1.17.18 processor](https://github.com/anomalyco/opencode/blob/v1.17.18/packages/opencode/src/session/processor.ts) stores the normalized LLM `step-finish` reason on the
assistant. Its [finish-reason schema](https://github.com/anomalyco/opencode/blob/v1.17.18/packages/llm/src/schema/ids.ts) enumerates `stop`, `length`,
`tool-calls`, `content-filter`, `error`, and `unknown`; the normal completed text
path uses `stop`.
