// completion-gate.test.ts — Unit tests for the pure evaluator functions.
//
// Verifies parseVerdict, evaluateRecovery, and evaluateVerifierFailure
// against the reference behavioral contract.

import {describe, expect, test} from 'bun:test';
import {
  accountSupersededClaim,
  buildRecoveryPrompt,
  classifyVerdictIdentity,
  type CompletionVerdict,
  evaluateRecovery,
  evaluateVerifierFailure,
  faultBackoffCapMs,
  faultBackoffMs,
  isAttestationFault,
  parseVerdict,
  type RecoveryConfig,
  type RecoveryState,
  resolveVerifier,
} from '../src/completion-gate.ts';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const CONFIG: RecoveryConfig = {maxRecoveryTurns: 12, maxUnchangedResults: 3};

function verdict(
  state: CompletionVerdict['state'],
  opts: Partial<CompletionVerdict> = {},
): CompletionVerdict {
  const terminal = state === 'COMPLETE' || state === 'CANCELLED';
  return {
    schema_version: 1,
    task_id: opts.task_id ?? 'task-1',
    state,
    candidate: opts.candidate ?? 'candidate-1',
    fingerprint: opts.fingerprint ?? 'fingerprint-1',
    outstanding:
      opts.outstanding ?? (terminal ? [] : ['focused test is failing']),
    evidence: opts.evidence ?? ['gmake check exited 0'],
  };
}

describe('parseVerdict', () => {
  test('accepts a valid COMPLETE verdict', () => {
    const v = parseVerdict(
      JSON.stringify({
        schema_version: 1,
        task_id: 'task-1',
        state: 'COMPLETE',
        candidate: 'abc123',
        fingerprint: 'def456',
        outstanding: [],
        evidence: ['gmake check exited 0'],
      }),
    );
    expect(v.state).toBe('COMPLETE');
    expect(v.outstanding).toEqual([]);
  });

  test('resolveVerifier consults a configured judge', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'goal-verifier-'));
    const judge = async () => verdict('COMPLETE');
    try {
      const resolution = await resolveVerifier({cwd, judge});
      expect(resolution.kind).toBe('judge');
    } finally {
      await rm(cwd, {recursive: true, force: true});
    }
  });

  test('resolveVerifier abstains when no judge is configured', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'goal-verifier-'));
    try {
      const resolution = await resolveVerifier({cwd, judge: null});
      expect(resolution.kind).toBe('unavailable');
    } finally {
      await rm(cwd, {recursive: true, force: true});
    }
  });

  test('accepts a valid WORKING verdict with outstanding gates', () => {
    const v = parseVerdict(
      JSON.stringify({
        schema_version: 1,
        task_id: 'task-1',
        state: 'WORKING',
        candidate: 'abc123',
        fingerprint: 'def456',
        outstanding: ['tests fail'],
        evidence: ['gmake check exited 2'],
      }),
    );
    expect(v.state).toBe('WORKING');
    expect(v.outstanding).toEqual(['tests fail']);
  });

  test('rejects COMPLETE with non-empty outstanding', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'task-1',
          state: 'COMPLETE',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: ['still work'],
          evidence: ['evidence'],
        }),
      ),
    ).toThrow('terminal state contradicts its evidence');
  });

  test('rejects WORKING with empty outstanding', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'task-1',
          state: 'WORKING',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: [],
          evidence: ['evidence'],
        }),
      ),
    ).toThrow('terminal state contradicts its evidence');
  });

  test('rejects empty evidence', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'task-1',
          state: 'COMPLETE',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: [],
          evidence: [],
        }),
      ),
    ).toThrow('terminal state contradicts its evidence');
  });

  test('rejects unknown fields', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'task-1',
          state: 'COMPLETE',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: [],
          evidence: ['evidence'],
          extra: 'not allowed',
        }),
      ),
    ).toThrow('unsupported fields');
  });

  test('rejects schema_version !== 1', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 2,
          task_id: 'task-1',
          state: 'COMPLETE',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: [],
          evidence: ['evidence'],
        }),
      ),
    ).toThrow('invalid verdict fields');
  });

  test('evidence items are bounded by evidence_item, not outstanding_item', () => {
    // Regression: boundedStrings previously hardcoded outstanding_item for
    // both arrays. Evidence must accept strings up to VERDICT_FIELD_MAX's
    // evidence_item limit. Both are 500 today, so this also guards that the
    // per-array itemMax is wired (a 500-char evidence string is accepted).
    const evidenceItem = 'x'.repeat(500);
    const v = parseVerdict(
      JSON.stringify({
        schema_version: 1,
        task_id: 'task-1',
        state: 'WORKING',
        candidate: 'abc123',
        fingerprint: 'def456',
        outstanding: ['gate-1'],
        evidence: [evidenceItem],
      }),
    );
    expect(v.evidence[0]).toBe(evidenceItem);
  });

  test('evidence item over the per-item limit is rejected', () => {
    expect(() =>
      parseVerdict(
        JSON.stringify({
          schema_version: 1,
          task_id: 'task-1',
          state: 'WORKING',
          candidate: 'abc123',
          fingerprint: 'def456',
          outstanding: ['gate-1'],
          evidence: ['x'.repeat(501)],
        }),
      ),
    ).toThrow('invalid verdict item');
  });
});

describe('captureCandidateIdentity (non-git directory digest)', () => {
  test('digest is deterministic across calls regardless of readdir order', async () => {
    // Regression: directoryDigest iterated unsorted readdir output, so the
    // fingerprint could vary across calls and spuriously reset the
    // unchangedResults heuristic in non-git repos.
    const {mkdtemp, writeFile, rm} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const {captureCandidateIdentity} =
      await import('../src/completion-gate.ts');

    const dir = await mkdtemp(join(tmpdir(), 'goal-digest-'));
    try {
      // Create several files; readdir order is filesystem-dependent.
      for (const name of ['zeta.txt', 'alpha.txt', 'mid.txt']) {
        await writeFile(join(dir, name), 'content');
      }
      const a = await captureCandidateIdentity(dir);
      const b = await captureCandidateIdentity(dir);
      expect(a.fingerprint).toBe(b.fingerprint);
      expect(a.fingerprint).not.toBe('unknown');
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});

describe('evaluateRecovery', () => {
  test('COMPLETE settles and resets recovery state', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 5,
      unchangedResults: 2,
      lastCandidate: 'old',
      lastFingerprint: 'old',
    };
    const {result, next} = evaluateRecovery(verdict('COMPLETE'), prior, CONFIG);
    expect(result.kind).toBe('settle-complete');
    expect(next.recoveryTurns).toBe(0);
    expect(next.unchangedResults).toBe(0);
    expect(next.lastCandidate).toBeNull();
  });

  test('BLOCKED settles and resets recovery state', () => {
    const {result, next} = evaluateRecovery(verdict('BLOCKED'), null, CONFIG);
    expect(result.kind).toBe('settle-blocked');
    expect(next.recoveryTurns).toBe(0);
  });

  test('NEEDS_INPUT settles and resets recovery state', () => {
    const {result} = evaluateRecovery(verdict('NEEDS_INPUT'), null, CONFIG);
    expect(result.kind).toBe('settle-needs-input');
  });

  test('CANCELLED settles and resets recovery state', () => {
    const {result} = evaluateRecovery(verdict('CANCELLED'), null, CONFIG);
    expect(result.kind).toBe('settle-cancelled');
  });

  test('WORKING increments recoveryTurns and recovers', () => {
    const {result, next} = evaluateRecovery(verdict('WORKING'), null, CONFIG);
    expect(result.kind).toBe('recover');
    if (result.kind === 'recover') {
      expect(result.recoveryN).toBe(1);
      expect(result.maxRecovery).toBe(12);
    }
    expect(next.recoveryTurns).toBe(1);
    expect(next.unchangedResults).toBe(0);
  });

  test('unchanged candidate+fingerprint increments unchangedResults', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 1,
      unchangedResults: 0,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {next} = evaluateRecovery(verdict('WORKING'), prior, CONFIG);
    expect(next.unchangedResults).toBe(1);
    expect(next.recoveryTurns).toBe(2);
  });

  test('candidate change resets unchangedResults but NOT recoveryTurns', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 3,
      unchangedResults: 2,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {next} = evaluateRecovery(
      verdict('WORKING', {candidate: 'candidate-2'}),
      prior,
      CONFIG,
    );
    expect(next.unchangedResults).toBe(0);
    expect(next.recoveryTurns).toBe(4); // NOT reset
  });

  test('task change resets BOTH counters', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 5,
      unchangedResults: 2,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {next} = evaluateRecovery(
      verdict('WORKING', {task_id: 'task-2'}),
      prior,
      CONFIG,
    );
    expect(next.taskID).toBe('task-2');
    expect(next.recoveryTurns).toBe(1); // reset to 0, then +1
    expect(next.unchangedResults).toBe(0);
  });

  test('escalates after maxRecoveryTurns', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 12,
      unchangedResults: 0,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {result} = evaluateRecovery(verdict('WORKING'), prior, CONFIG);
    expect(result.kind).toBe('escalate');
  });

  test('escalates after maxUnchangedResults', () => {
    // With > semantics: maxUnchangedResults=3 allows 3 unchanged turns.
    // prior.unchangedResults=3 → incremented to 4 → 4 > 3 → escalate.
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 1,
      unchangedResults: 3,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {result} = evaluateRecovery(verdict('WORKING'), prior, CONFIG);
    expect(result.kind).toBe('escalate');
  });

  test('does NOT escalate at maxUnchangedResults boundary (allowed count)', () => {
    // With > semantics: maxUnchangedResults=3 allows 3 unchanged turns.
    // prior.unchangedResults=2 → incremented to 3 → 3 > 3 is false → recover.
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 1,
      unchangedResults: 2,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {result} = evaluateRecovery(verdict('WORKING'), prior, CONFIG);
    expect(result.kind).toBe('recover');
  });

  // per-goal recovery config (not plugin defaults)

  test('per-goal maxRecoveryTurns=5 escalates at turn 6, not 13', () => {
    // Reproduces evaluateRecovery must use the per-goal config,
    // not plugin-level defaults. With maxRecoveryTurns=5, escalation occurs
    // when recoveryTurns > 5 (i.e., at turn 6), not when > 12 (turn 13).
    const perGoalConfig: RecoveryConfig = {
      maxRecoveryTurns: 5,
      maxUnchangedResults: 3,
    };
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 5, // exactly at the limit
      unchangedResults: 0,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    // Turn 6: 6 > 5 → escalate
    const {result} = evaluateRecovery(verdict('WORKING'), prior, perGoalConfig);
    expect(result.kind).toBe('escalate');
  });

  test('per-goal maxRecoveryTurns=5 does NOT escalate at turn 5', () => {
    const perGoalConfig: RecoveryConfig = {
      maxRecoveryTurns: 5,
      maxUnchangedResults: 3,
    };
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 4,
      unchangedResults: 0,
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    // Turn 5: 5 > 5 is false → recover
    const {result} = evaluateRecovery(verdict('WORKING'), prior, perGoalConfig);
    expect(result.kind).toBe('recover');
  });

  test('per-goal maxUnchangedResults=2 escalates at unchanged=3, not 2', () => {
    // With > semantics: maxUnchangedResults=2 allows 2 unchanged turns.
    // prior.unchangedResults=1 → incremented to 2 → 2 > 2 is false → recover.
    // prior.unchangedResults=2 → incremented to 3 → 3 > 2 → escalate.
    const perGoalConfig: RecoveryConfig = {
      maxRecoveryTurns: 12,
      maxUnchangedResults: 2,
    };
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 1,
      unchangedResults: 2, // 2 unchanged were prior; 3rd will trigger
      lastCandidate: 'candidate-1',
      lastFingerprint: 'fingerprint-1',
    };
    const {result} = evaluateRecovery(verdict('WORKING'), prior, perGoalConfig);
    expect(result.kind).toBe('escalate');
  });
});

describe('evaluateVerifierFailure', () => {
  test('unavailable is a FAULT to retry, not a verdict and not a settlement', () => {
    // No attestation could be obtained, which says NOTHING about the goal. The
    // old behaviour treated this as an abstention that kept the goal active
    // forever: the completion intent was discarded and the agent could only
    // assert again (~594k tokens, and the only terminal action left was to
    // misrepresent finished work as blocked). A fault is retried instead.
    const {result, next} = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'unavailable'},
      'task-1',
    );
    expect(result.kind).toBe('retry-fault');
    if (result.kind === 'retry-fault') {
      expect(result.attempt).toBe(1);
      expect(result.maxAttempts).toBeGreaterThan(1);
      expect(result.backoffMs).toBeGreaterThanOrEqual(0);
      expect(result.reason).toContain('retry 1/');
    }
    // A fault consumes no recovery budget.
    expect(next.recoveryTurns).toBe(0);
  });

  test('a fault past the bound SETTLES with a receipt instead of looping', () => {
    // The whole point: a sustained fault must END the goal honestly, not hang it.
    const {result} = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'unavailable'},
      'task-1',
      5,
      5,
    );
    expect(result.kind).toBe('settle-unattestable');
    if (result.kind === 'settle-unattestable') {
      expect(result.attempts).toBe(6);
      expect(result.reason).toContain('6 consecutive attempts');
      expect(result.reason).toContain('no attestation');
    }
  });

  test('the fault counter is CONSECUTIVE — attempt 1 is retry, not instant settle', () => {
    // Shows the counter resets (the caller passes 0 after any success) and that
    // a single fault never settles: only a SUSTAINED fault does.
    const first = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
      0,
      3,
    );
    expect(first.result.kind).toBe('retry-fault');
    const second = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
      1,
      3,
    );
    expect(second.result.kind).toBe('retry-fault');
    const third = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
      2,
      3,
    );
    expect(third.result.kind).toBe('retry-fault');
    const fourth = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
      3,
      3,
    );
    expect(fourth.result.kind).toBe('settle-unattestable');
  });

  test('identity-mismatch is a SIGNAL, not a fault — the judge answered', () => {
    // The distinction that keeps the mechanism honest: `identity-mismatch` means
    // the judge answered, and the answer is not about this work — real evidence
    // about the claim. It must take bounded recovery, NOT the retry path.
    const {result} = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'identity-mismatch', detail: 'x'},
      'task-1',
    );
    expect(result.kind).toBe('recover');
  });

  test('attestation faults still never fabricate COMPLETE', () => {
    for (const failure of [
      {kind: 'judge-error', error: 'timed out'},
      {
        kind: 'judge-error',
        error: 'truncated',
      },
      {kind: 'judge-error', error: 'aborted'},
      {kind: 'judge-error', error: 'enoent'},
    ] as const) {
      for (const attempts of [0, 99]) {
        const {result} = evaluateVerifierFailure(
          null,
          CONFIG,
          failure,
          'task-1',
          attempts,
          5,
        );
        expect(result.kind).not.toBe('settle-complete');
      }
    }
  });

  test('operational failures never fabricate COMPLETE (fail-closed)', () => {
    // A configured verifier that RAN and failed must not settle-complete.
    for (const failure of [
      {kind: 'judge-error', error: 'timed out'},
      {kind: 'identity-mismatch', detail: 'x'},
      {kind: 'judge-error', error: 'bad json'},
      {kind: 'judge-error', error: 'truncated'},
      {kind: 'judge-error', error: 'aborted'},
      {kind: 'judge-error', error: 'enoent'},
    ] as const) {
      const {result} = evaluateVerifierFailure(null, CONFIG, failure, 'task-1');
      expect(result.kind).not.toBe('settle-complete');
      expect(result.kind).not.toBe('abstain');
    }
  });

  test('judge-error is a fault → retried, never settled on the first failure', () => {
    const {result} = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
    );
    expect(result.kind).toBe('retry-fault');
  });

  test('a malformed judge verdict is a fault → retried, never settled on the first failure', () => {
    const {result} = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'bad json'},
      'task-1',
    );
    expect(result.kind).toBe('retry-fault');
  });

  test('a fault ignores the recovery budget — it is not recovery', () => {
    // A fault is not a finding about the goal, so an exhausted RECOVERY budget
    // is irrelevant to it: the fault counter is its own bound. Conflating the
    // two is what made the old path escalate a healthy goal's transient network
    // failure as though the work had failed.
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 12,
      unchangedResults: 0,
      lastCandidate: null,
      lastFingerprint: null,
    };
    const {result} = evaluateVerifierFailure(
      prior,
      CONFIG,
      {kind: 'judge-error', error: 'timed out'},
      'task-1',
      0,
      5,
    );
    expect(result.kind).toBe('retry-fault');
  });

  test('judge-error is bounded cheaply — NOT 12 recovery turns', () => {
    // The fault bound is ~5 short backoffs (expected under ~4s), so a persistently
    // failing judge settles quickly rather than burning the whole recovery budget.
    const first = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'enoent'},
      'task-1',
      0,
      5,
    );
    expect(first.result.kind).toBe('retry-fault');
    const exhausted = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'enoent'},
      'task-1',
      5,
      5,
    );
    expect(exhausted.result.kind).toBe('settle-unattestable');
    // Backoff is bounded and short at every attempt.
    for (let attempt = 1; attempt <= 5; attempt++) {
      const r = evaluateVerifierFailure(
        null,
        CONFIG,
        {kind: 'judge-error', error: 'enoent'},
        'task-1',
        attempt - 1,
        5,
      );
      if (r.result.kind === 'retry-fault')
        expect(r.result.backoffMs).toBeLessThanOrEqual(4000);
    }
  });

  test('judge-error with a fresh prior still retries first, then settles', () => {
    const prior: RecoveryState = {
      taskID: 'task-1',
      recoveryTurns: 0,
      unchangedResults: 0,
      lastCandidate: null,
      lastFingerprint: null,
    };
    const {result} = evaluateVerifierFailure(
      prior,
      CONFIG,
      {kind: 'judge-error', error: 'eacces'},
      'task-1',
      0,
      2,
    );
    expect(result.kind).toBe('retry-fault');
    const spent = evaluateVerifierFailure(
      prior,
      CONFIG,
      {kind: 'judge-error', error: 'eacces'},
      'task-1',
      2,
      2,
    );
    expect(spent.result.kind).toBe('settle-unattestable');
  });

  test('a malformed judge verdict retries first (transient tolerance), then settles with a receipt', () => {
    // A malformed verdict may be transient; a persistent one must not spin.
    const first = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'bad json'},
      'task-1',
      0,
      2,
    );
    expect(first.result.kind).toBe('retry-fault');
    const spent = evaluateVerifierFailure(
      null,
      CONFIG,
      {kind: 'judge-error', error: 'bad json'},
      'task-1',
      2,
      2,
    );
    expect(spent.result.kind).toBe('settle-unattestable');
    if (spent.result.kind === 'settle-unattestable') {
      expect(spent.result.reason).toContain('judge error');
    }
  });

  test('judge-error never fabricates COMPLETE, however many times it recurs', () => {
    for (let attempts = 0; attempts <= 6; attempts++) {
      const {result} = evaluateVerifierFailure(
        null,
        CONFIG,
        {
          kind: 'judge-error',
          error: 'bad json',
        },
        'task-1',
        attempts,
        5,
      );
      expect(result.kind).not.toBe('settle-complete');
    }
  });
});

describe('buildRecoveryPrompt', () => {
  test('includes task_id, candidate, outstanding, evidence, budget', () => {
    const v = verdict('WORKING');
    const prompt = buildRecoveryPrompt(v, 2, 12, null);
    expect(prompt).toContain('task-1');
    expect(prompt).toContain('candidate-1');
    expect(prompt).toContain('focused test is failing');
    expect(prompt).toContain('gmake check exited 0');
    expect(prompt).toContain('Recovery 2 of 12');
  });

  test('includes phrase-triage reason when provided', () => {
    const prompt = buildRecoveryPrompt(
      verdict('WORKING'),
      1,
      12,
      'triage signal here',
    );
    expect(prompt).toContain('Advisory: triage signal here');
  });

  test('omits advisory line when phraseReason is null', () => {
    const prompt = buildRecoveryPrompt(verdict('WORKING'), 1, 12, null);
    expect(prompt).not.toContain('Advisory:');
  });

  test('includes the escape path (BLOCKED/NEEDS_INPUT/CANCELLED)', () => {
    const prompt = buildRecoveryPrompt(verdict('WORKING'), 1, 12, null);
    expect(prompt).toContain('BLOCKED');
    expect(prompt).toContain('NEEDS_INPUT');
    expect(prompt).toContain('CANCELLED');
  });
});

// The unchanged axis must not count freshness-unknown markers
//
// When the working tree cannot be fingerprinted (truncated diff, more untracked
// files than the bounded scan allows, an unreadable/oversized untracked file)
// the marker is `freshness-unknown:<reason>` — a CONSTANT for the whole run.
// Two markers compare equal, so the unchanged heuristic saw "nothing changed" on
// every recovery turn and escalated a HEALTHY goal after maxUnchangedResults
// turns while files were changing every turn. Reproduced before the fix: five
// WORKING verdicts with a constant freshness-unknown fingerprint escalated at
// turn 5 (4 unchanged > 3).

describe('freshness-unknown fingerprints do not drive the unchanged axis', () => {
  const cfg: RecoveryConfig = {maxRecoveryTurns: 12, maxUnchangedResults: 3};

  function workingVerdict(fingerprint: string): CompletionVerdict {
    return {
      schema_version: 1,
      task_id: 'task-1',
      state: 'WORKING',
      candidate: 'abc1234',
      fingerprint,
      outstanding: [],
      evidence: [],
    };
  }

  test('a constant freshness-unknown marker never accumulates unchanged turns', () => {
    const marker = 'freshness-unknown:untracked-count';
    let state: RecoveryState | null = null;
    for (let turn = 0; turn < 6; turn++) {
      const {result, next} = evaluateRecovery(
        workingVerdict(marker),
        state,
        cfg,
      );
      state = next;
      // The total budget still governs; the unchanged axis must never fire.
      expect(result.kind).toBe('recover');
      expect(next.unchangedResults).toBe(0);
    }
  });

  test('the total recovery budget still escalates when turns are exhausted', () => {
    const marker = 'freshness-unknown:untracked-count';
    let state: RecoveryState | null = null;
    let escalated = false;
    for (let turn = 0; turn < 20; turn++) {
      const {result, next} = evaluateRecovery(
        workingVerdict(marker),
        state,
        cfg,
      );
      state = next;
      if (result.kind === 'escalate') {
        escalated = true;
        break;
      }
    }
    // Abstaining on the unchanged axis must NOT disable the bound entirely.
    expect(escalated).toBe(true);
  });

  test('REAL fingerprints still drive the unchanged axis', () => {
    // The guard must not neuter the heuristic it protects.
    const real = '9f8e7d6c5b4a39281706f5e4d3c2b1a0';
    let state: RecoveryState | null = null;
    const kinds: string[] = [];
    for (let turn = 0; turn < 6; turn++) {
      const {result, next} = evaluateRecovery(workingVerdict(real), state, cfg);
      state = next;
      kinds.push(result.kind);
    }
    expect(kinds).toContain('escalate');
  });

  test('a CHANGING real fingerprint never accumulates unchanged turns', () => {
    let state: RecoveryState | null = null;
    for (let turn = 0; turn < 6; turn++) {
      const {result, next} = evaluateRecovery(
        workingVerdict(`real-${turn}`),
        state,
        cfg,
      );
      state = next;
      expect(result.kind).toBe('recover');
      expect(next.unchangedResults).toBe(0);
    }
  });
});

// COMPLETION-ATTESTATION-1: a finished goal can END
//
// The defect this locks: a live session released software and PROVED it
// (`gmake release.verify` PASS), yet the goal never settled — 8 auto-continues,
// ~594k tokens, and the only terminal action left to the agent was to
// misrepresent finished work as `blocked`. A fault obtaining an attestation must
// be retried and then SETTLE, never loop.

describe('an unobtainable attestation ends the goal', () => {
  test('a sustained fault settles instead of looping forever', () => {
    // Walk the fault counter exactly as the caller does: increment per fault,
    // reset to 0 after any success. The goal must reach a terminal settlement.
    let attempts = 0;
    let settled = false;
    for (let i = 0; i < 50 && !settled; i++) {
      const {result} = evaluateVerifierFailure(
        null,
        CONFIG,
        {kind: 'unavailable'},
        'task-1',
        attempts,
        5,
      );
      if (result.kind === 'settle-unattestable') {
        settled = true;
        break;
      }
      expect(result.kind).toBe('retry-fault');
      attempts += 1;
    }
    expect(settled).toBe(true);
    // And it took the BOUND, not unbounded retries.
    expect(attempts).toBe(5);
  });

  test('a success resets the run, so a later fault starts from 1', () => {
    // The caller resets after any real verdict. Shows the counter measures a
    // CONSECUTIVE run: intermittent faults must never accumulate to a settle.
    const afterSuccess = evaluateVerifierFailure(
      null,
      CONFIG,
      {
        kind: 'judge-error',
        error: 'timed out',
      },
      'task-1',
      0,
      5,
    );
    expect(afterSuccess.result.kind).toBe('retry-fault');
    if (afterSuccess.result.kind === 'retry-fault')
      expect(afterSuccess.result.attempt).toBe(1);
  });

  test('backoff grows exponentially and saturates at the ceiling', () => {
    // Assert the deterministic SCHEDULE, not sampled maxima — comparing sampled
    // maxima is itself nondeterministic, and a flaky test is a bad test.
    expect(faultBackoffCapMs(1)).toBe(250);
    expect(faultBackoffCapMs(2)).toBe(500);
    expect(faultBackoffCapMs(3)).toBe(1000);
    expect(faultBackoffCapMs(4)).toBe(2000);
    expect(faultBackoffCapMs(5)).toBe(4000);
    // Saturates rather than growing without bound.
    for (const a of [6, 7, 12, 99]) expect(faultBackoffCapMs(a)).toBe(4000);
    // Strictly increasing until the ceiling.
    for (let a = 2; a <= 5; a++)
      expect(faultBackoffCapMs(a)).toBeGreaterThan(faultBackoffCapMs(a - 1));
  });

  test('full jitter keeps every wait inside its cap', () => {
    // Deterministic bound: the random draw is always in [0, cap). This is the
    // property that matters (no wait exceeds the schedule), asserted without
    // depending on which values the RNG happened to produce.
    for (const a of [1, 3, 5, 9]) {
      const cap = faultBackoffCapMs(a);
      for (let i = 0; i < 200; i++) {
        const ms = faultBackoffMs(a);
        expect(ms).toBeGreaterThanOrEqual(0);
        expect(ms).toBeLessThan(cap === 0 ? 1 : cap);
      }
    }
  });

  test('a stuck agent still PAUSES rather than being settled by the fault bound', () => {
    // The two axes stay distinct: a fault over a MOVING workspace settles (the
    // agent did work, we just could not check it), but a fault over an UNCHANGED
    // workspace is a stuck agent and must pause. Otherwise a looping agent's
    // repeated assertions would eventually be accepted as completion.
    // (Enforced in hooks.ts; asserted end-to-end in test/claim-ledger.test.ts.)
    expect(isAttestationFault({kind: 'unavailable'})).toBe(true);
    expect(isAttestationFault({kind: 'judge-error', error: 'x'})).toBe(true);
    expect(isAttestationFault({kind: 'identity-mismatch', detail: 'x'})).toBe(
      false,
    );
  });
});

// A workspace file the agent wrote is NOT a verifier
//
// User ruling 2026-11-01: the agent-registered command check
// (.opencode/goal-verify.sh) is pruned. A script written by the same party
// whose claim it would attest is not independent evidence, and running
// agent-written shell in the user's workspace is an execution primitive, not
// a verifier. These tests lock the removal: a goal-verify.sh in the workspace
// must be ignored, and the project's own gate must win over anything in the
// workspace.
// Command verifiers are pruned: the plugin never runs a program
//
// User ruling 2026-11-01: ALL mechanical completion gates are pruned — the
// agent-registered script (prune #1), the workspace Makefile target, the
// explicit verifierCommand, and the auto-detected test command. All execution
// is agent-driven: the agent runs checks with its own tools and the judge
// attests the claim. These tests lock the removal: none of those workspace
// artifacts may influence resolution, and the only resolution is the judge or
// "unavailable".
describe('command verifiers are pruned: only the judge resolves', () => {
  async function workspaceWithArtifacts(): Promise<string> {
    const {mkdtemp, mkdir, writeFile} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'goal-cmdverifier-'));
    await mkdir(join(dir, '.opencode'), {recursive: true});
    await writeFile(
      join(dir, '.opencode', 'goal-verify.sh'),
      'exit 0\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'Makefile'),
      'completion-gate-json:\n\t@echo project-gate\n',
      'utf8',
    );
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({scripts: {test: 'bun test'}}),
      'utf8',
    );
    return dir;
  }

  test('a workspace goal-verify.sh, Makefile gate, and package.json test script are ALL ignored', async () => {
    const cwd = await workspaceWithArtifacts();
    try {
      const resolution = await resolveVerifier({cwd, judge: null});
      expect(resolution.kind).toBe('unavailable');
    } finally {
      const {rm} = await import('node:fs/promises');
      await rm(cwd, {recursive: true, force: true});
    }
  });

  test('even with every workspace artifact present, a configured judge is the resolution', async () => {
    const cwd = await workspaceWithArtifacts();
    const judge = async () => verdict('COMPLETE');
    try {
      const resolution = await resolveVerifier({cwd, judge});
      expect(resolution.kind).toBe('judge');
      if (resolution.kind === 'judge')
        expect(typeof resolution.judge).toBe('function');
    } finally {
      const {rm} = await import('node:fs/promises');
      await rm(cwd, {recursive: true, force: true});
    }
  });

  test('resolution never mentions a command, make target, or test script', async () => {
    const cwd = await workspaceWithArtifacts();
    try {
      for (const judge of [null, async () => verdict('WORKING')]) {
        const resolution = await resolveVerifier({cwd, judge});
        const text = JSON.stringify(resolution);
        expect(text).not.toContain('goal-verify.sh');
        expect(text).not.toContain('completion-gate-json');
        expect(text).not.toContain('bun test');
        expect(text).not.toContain('gmake');
      }
    } finally {
      const {rm} = await import('node:fs/promises');
      await rm(cwd, {recursive: true, force: true});
    }
  });
});

// The two completion-path rules that were enforced and unexercised together, and
// both of which a review found live. Each is now a pure function precisely so a
// test can reach it: the inline versions sat several frames deep inside the tool
// handler in hooks.ts — a rule nothing can execute is not a rule.
describe('a verdict that names a different candidate is rejected, not retried', () => {
  const before = {candidate: 'abc123', fingerprint: 'fp-before'};

  test('a candidate mismatch is an identity-mismatch REJECTION', () => {
    const failure = classifyVerdictIdentity(before, {
      candidate: 'def456',
      fingerprint: 'fp-before',
    });
    expect(failure?.kind).toBe('identity-mismatch');
    expect(isAttestationFault(failure!)).toBe(false);
  });

  test('the captured candidate matches: no finding', () => {
    expect(
      classifyVerdictIdentity(before, {
        candidate: 'abc123',
        fingerprint: 'anything',
      }),
    ).toBeNull();
  });
});

describe('a superseded completion assertion is counted on BOTH axes', () => {
  const limits = {maxUnchangedResults: 3, maxRecoveryTurns: 12};
  // A freshness check that treats only the literal sentinel as unknown, which
  // is what the real one does.
  const fresh = (fingerprint: string | null | undefined): boolean =>
    fingerprint !== 'UNKNOWN';

  test('a MOVING workspace still advances the total budget, which is what bounds it', () => {
    // THE DEFECT. The old code counted only the unchanged axis, so a workspace
    // that changes between assertions incremented nothing at all — and this exit
    // sends no prompt, so the turn counter does not advance either. Measured
    // before the fix: 25 consecutive discarded assertions, every counter 0.
    let goal = {
      ...limits,
      unchangedResults: 0,
      recoveryTurns: 0,
      lastCandidate: 'a',
      lastFingerprint: 'f1',
    };
    let stopped: string | null = null;
    for (let i = 0; i < 25; i++) {
      // A DIFFERENT fingerprint each time, so the unchanged axis stays at 0.
      const identity = {candidate: `c${i}`, fingerprint: `f${i}`};
      const next = accountSupersededClaim(goal, identity, fresh);
      goal = {
        ...goal,
        unchangedResults: next.unchangedResults,
        recoveryTurns: next.recoveryTurns,
      };
      stopped = next.stoppedBecause;
      if (stopped) break;
    }
    console.log(
      `SUPERSEDED-MOVING stopped=${stopped} recoveryTurns=${goal.recoveryTurns}`,
    );
    expect(stopped, 'a moving workspace must still be bounded').toBe(
      'recovery-exhausted',
    );
    expect(goal.recoveryTurns).toBe(limits.maxRecoveryTurns + 1);
  });

  test('an UNCHANGED workspace pauses on the unchanged axis, as it always did', () => {
    let goal = {
      ...limits,
      unchangedResults: 0,
      recoveryTurns: 0,
      lastCandidate: 'a',
      lastFingerprint: 'f1',
    };
    const identity = {candidate: 'a', fingerprint: 'f1'};
    let stopped: string | null = null;
    for (let i = 0; i < 10; i++) {
      const next = accountSupersededClaim(goal, identity, fresh);
      goal = {
        ...goal,
        unchangedResults: next.unchangedResults,
        recoveryTurns: next.recoveryTurns,
      };
      stopped = next.stoppedBecause;
      if (stopped) break;
    }
    expect(stopped).toBe('unchanged');
    expect(goal.unchangedResults).toBe(limits.maxUnchangedResults + 1);
  });

  test('an unknown fingerprint disables the unchanged axis instead of counting a constant', () => {
    // Counting "unknown == unknown" as evidence of no change would pause a goal
    // for doing nothing, in a workspace the capture could not hash.
    const next = accountSupersededClaim(
      {
        ...limits,
        unchangedResults: 0,
        recoveryTurns: 0,
        lastCandidate: null,
        lastFingerprint: 'UNKNOWN',
      },
      {candidate: null, fingerprint: 'UNKNOWN'},
      fresh,
    );
    expect(
      next.unchangedResults,
      'an unknown fingerprint is not evidence of no change',
    ).toBe(0);
    // …and the total budget still advances, so even that case is bounded.
    expect(next.recoveryTurns).toBe(1);
  });

  test('a first superseded assertion stops nothing', () => {
    const next = accountSupersededClaim(
      {
        ...limits,
        unchangedResults: 0,
        recoveryTurns: 0,
        lastCandidate: 'a',
        lastFingerprint: 'f1',
      },
      {candidate: 'b', fingerprint: 'f2'},
      fresh,
    );
    expect(next.stoppedBecause).toBeNull();
    expect(next.unchangedResults).toBe(0);
    expect(next.recoveryTurns).toBe(1);
  });
});
