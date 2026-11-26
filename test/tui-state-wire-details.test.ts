import {expect, test} from 'bun:test';
import {createGoalState, type ClaimRecord} from '../src/state-machine.ts';
import {
  createTuiStateStore,
  decodeGoalToolMetadata,
  encodeGoalToolMetadata,
  parseTuiSyncEvent,
  serializeGoalForTui,
  type GoalTuiEvent,
} from '../src/tui-state.ts';
import {ToastCoalescer} from '../src/tui-toast-policy.ts';

function goalWithDetails() {
  const goal = createGoalState('wire-session', 'Deliver the requested result');
  const claim: ClaimRecord = {
    claimId: 'claim-1',
    timestamp: 100,
    actor: 'agent',
    claimedStatus: 'complete',
    claimText: 'The requested result is ready.',
    check: {
      path: 'judge',
      target: 'goal-verify',
      verdict: 'JUDGE_FAILURE',
      evidence: ['The verifier remained unavailable.'],
      timestamp: 101,
    },
    outcome: {
      status: 'unverifiable-claim',
      detail: 'Settled without an attestation after bounded faults.',
      timestamp: 102,
    },
  };
  goal.status = 'complete';
  goal.claims = [claim];
  goal.lastClaim = claim;
  goal.artifactPointers = ['result.md'];
  goal.pendingProposal = {
    proposalId: 'proposal-1',
    proposedAt: 99,
    objective: 'Revised objective',
    successCriteria: 'A readable result',
    constraints: 'Preserve prior work',
    artifactPointers: ['additional.md'],
    reason: 'Clarify the deliverable',
  };
  return goal;
}

function wireEvent(): GoalTuiEvent {
  const goal = goalWithDetails();
  return {
    kind: 'transition',
    sessionID: goal.sessionID,
    timestamp: 103,
    previousStatus: 'active',
    transition: {
      source: 'completion-gate',
      from: 'active',
      to: 'complete',
      detail: 'Unattested settlement',
    },
    snapshot: {...serializeGoalForTui(goal), origin: 'disk'},
  };
}

test('tool metadata carries the unattested outcome through the store to the completion toast', () => {
  const event = wireEvent();
  const decoded = decodeGoalToolMetadata(encodeGoalToolMetadata([event]));
  expect(decoded).toHaveLength(1);
  const store = createTuiStateStore();
  const messages: string[] = [];
  const coalescer = new ToastCoalescer(toast => messages.push(toast.message));
  store.subscribe(next => coalescer.accept(next, next.sessionID));
  store.applyEvent(decoded![0]);
  const snapshot = store.getSnapshot(event.sessionID, event.snapshot!.goalId)!;
  expect(snapshot.lastClaim?.outcome.status).toBe('unverifiable-claim');
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('no attestation could be obtained');
});

test('JSON and metadata transports retain all optional snapshot details and provenance', () => {
  const event = wireEvent();
  const fromJson = parseTuiSyncEvent(JSON.stringify(event));
  const fromMetadata = decodeGoalToolMetadata(
    encodeGoalToolMetadata([event]),
  )?.[0];
  for (const decoded of [fromJson, fromMetadata]) {
    expect(decoded?.snapshot).toEqual(event.snapshot);
    expect(decoded?.previousStatus).toBe('active');
  }
});

test('serializing nested claims and proposal pointers does not freeze or alias the caller state', () => {
  const goal = goalWithDetails();
  const snapshot = serializeGoalForTui(goal);
  expect(Object.isFrozen(goal.lastClaim!.check)).toBe(false);
  expect(Object.isFrozen(goal.lastClaim!.outcome)).toBe(false);
  expect(Object.isFrozen(goal.lastClaim!.check.evidence)).toBe(false);
  expect(Object.isFrozen(goal.pendingProposal!.artifactPointers)).toBe(false);
  goal.lastClaim!.check.evidence!.push('Later evidence');
  goal.lastClaim!.outcome.detail = 'Later detail';
  goal.pendingProposal!.artifactPointers!.push('later.md');
  expect(snapshot.lastClaim!.check.evidence).toEqual([
    'The verifier remained unavailable.',
  ]);
  expect(snapshot.claims![0].outcome.detail).toBe(
    'Settled without an attestation after bounded faults.',
  );
  expect(snapshot.pendingProposal!.artifactPointers).toEqual(['additional.md']);
  expect(Object.isFrozen(snapshot.lastClaim!.check.evidence)).toBe(true);
  expect(Object.isFrozen(snapshot.claims![0].outcome)).toBe(true);
});

test('decoding copies nested details before freezing them', () => {
  const event = JSON.parse(JSON.stringify(wireEvent())) as GoalTuiEvent;
  const decoded = decodeGoalToolMetadata(encodeGoalToolMetadata([event]))![0];
  const incomingClaim = event.snapshot!.lastClaim!;
  incomingClaim.check.evidence!.push('Later transport mutation');
  incomingClaim.outcome.detail = 'Changed outside the store';
  event.snapshot!.pendingProposal!.artifactPointers!.push('later.md');
  expect(decoded.snapshot!.lastClaim!.check.evidence).toEqual([
    'The verifier remained unavailable.',
  ]);
  expect(decoded.snapshot!.lastClaim!.outcome.detail).toBe(
    'Settled without an attestation after bounded faults.',
  );
  expect(decoded.snapshot!.pendingProposal!.artifactPointers).toEqual([
    'additional.md',
  ]);
});

test('a mutable history array at its length cap does not reuse a stale projection', () => {
  const goal = createGoalState('history-session', 'goal');
  goal.history = Array.from({length: 100}, (_, timestamp) => ({
    type: 'tracking',
    detail: String(timestamp),
    timestamp,
  }));
  const before = serializeGoalForTui(goal);
  goal.history.push({type: 'paused', detail: 'new stop', timestamp: 100});
  goal.history.shift();
  const after = serializeGoalForTui(goal);
  expect(before.history.at(-1)?.detail).toBe('99');
  expect(after.history.at(-1)?.detail).toBe('new stop');
});

test('older snapshots may omit optional details without inventing an attestation', () => {
  const event = JSON.parse(JSON.stringify(wireEvent())) as {
    snapshot: Record<string, unknown>;
  };
  for (const field of [
    'lastClaim',
    'claims',
    'pendingProposal',
    'artifactPointers',
    'origin',
  ])
    delete event.snapshot[field];
  const decoded = parseTuiSyncEvent(JSON.stringify(event));
  expect(decoded).not.toBeNull();
  expect(decoded!.snapshot!.lastClaim).toBeUndefined();
  expect(decoded!.snapshot!.claims).toBeUndefined();
});

for (const [field, value] of [
  ['lastClaim', {}],
  [
    'lastClaim',
    {...goalWithDetails().lastClaim!, outcome: {status: 'unknown'}},
  ],
  ['claims', [null]],
  [
    'pendingProposal',
    {...goalWithDetails().pendingProposal!, proposedAt: Infinity},
  ],
  ['artifactPointers', [42]],
  ['origin', 'unknown'],
] as const) {
  test(`malformed optional ${field} cannot produce an unqualified completion`, () => {
    const event = wireEvent();
    const invalid = {...event, snapshot: {...event.snapshot!, [field]: value}};
    expect(
      decodeGoalToolMetadata(encodeGoalToolMetadata([invalid as GoalTuiEvent])),
    ).toBeNull();
  });
}

for (const field of [
  'revision',
  'turnCount',
  'totalTokens',
  'maxTokens',
  'maxTurns',
  'tokenBudget',
  'createdAt',
  'updatedAt',
  'finishedAt',
]) {
  test(`non-finite ${field} cannot poison snapshot ordering or accounting`, () => {
    const event = wireEvent();
    for (const value of [NaN, Infinity, -Infinity, -1]) {
      const invalid = {
        ...event,
        snapshot: {...event.snapshot!, [field]: value},
      };
      expect(
        decodeGoalToolMetadata(encodeGoalToolMetadata([invalid])),
      ).toBeNull();
    }
  });
}

test('non-finite nested usage, history, and checkpoint values are rejected', () => {
  const event = wireEvent();
  for (const snapshot of [
    {...event.snapshot!, usage: {...event.snapshot!.usage, cost: Infinity}},
    {
      ...event.snapshot!,
      history: [{type: 'paused', detail: '', timestamp: NaN}],
    },
    {
      ...event.snapshot!,
      lastCheckpoint: {summary: 'checkpoint', timestamp: Infinity},
    },
  ])
    expect(
      decodeGoalToolMetadata(encodeGoalToolMetadata([{...event, snapshot}])),
    ).toBeNull();
});
