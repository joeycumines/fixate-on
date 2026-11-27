import {describe, expect, test} from 'bun:test';
import {
  buildVerdictPrompt,
  createChildSessionVerifier,
  parseVerdictFromJudge,
} from '../src/child-session-verifier.ts';
import {VERIFIER_SESSION_PERMISSIONS} from '../src/plugin-v2-tools-agents.ts';
import {verifierSessionID, verifierSessionInfo} from './verifier-fixtures.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState} from '../src/state-machine.ts';
import type {CandidateIdentity} from '../src/completion-gate.ts';

function makeGoal(): GoalState {
  return {
    goalId: 'goal-123',
    runId: 'run-1',
    revision: 0,
    condition: 'fix the tests',
    successCriteria: '',
    constraints: '',
    artifactPointers: [],
    pendingProposal: null,
    mode: 'normal',
    sessionID: 'session-1',
    tokenBudget: null,
    maxTokens: 200000,
    maxTurns: 10,
    maxDurationMs: 900000,
    minDelayMs: 1500,
    noProgressTokenThreshold: 50,
    noProgressTurnsBeforePause: 2,
    noToolCallTurnsBeforePause: 2,
    turnCount: 0,
    totalTokens: 0,
    compactionBaselineTokens: 0,
    usage: {
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      costKnown: false,
    },
    createdAt: 0,
    updatedAt: 0,
    startedAt: 0,
    pausedAt: 0,
    stoppedAt: 0,
    finishedAt: null,
    status: 'active',
    stopReason: '',
    blockedReason: '',
    finalizing: false,
    budgetLimitReported: false,
    budgetWrapupSent: false,
    objectiveUpdatedPending: false,
    noProgressTurns: 0,
    noToolCallTurns: 0,
    promptFailures: 0,
    recoveryTurns: 0,
    maxRecoveryTurns: 12,
    unchangedResults: 0,
    maxUnchangedResults: 3,
    lastCandidate: null,
    lastFingerprint: null,
    blockedTurns: 0,
    maxBlockedTurns: 3,
    blockedAssertedThisTurn: false,
    languageTriage: true,
    lastStatus: '',
    lastAssistantText: '',
    lastAssistantMessageID: '',
    lastContinueAt: 0,
    lastProgressAt: 0,
    continuationClaim: null,
    pendingNotices: [],
    history: [],
    lastCheckpoint: null,
    checkpoints: [],
    claims: [],
    lastClaim: null,
    messageIDs: new Set(),
    executionContext: null,
  };
}

const candidate: CandidateIdentity = {
  candidate: 'abc1234',
  fingerprint: 'deadbeef',
};

describe('parseVerdictFromJudge', () => {
  test('extracts a COMPLETE verdict from a JSON-only response', () => {
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['gmake check exited 0'],
    });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.task_id).toBe('goal-123');
  });

  test('extracts a WORKING verdict from prose + JSON', () => {
    const text =
      'I inspected the workspace. The tests are still failing.\n' +
      JSON.stringify({
        schema_version: 1,
        task_id: 'goal-123',
        state: 'WORKING',
        candidate: 'abc1234',
        fingerprint: 'deadbeef',
        outstanding: ['test X fails'],
        evidence: ['gmake check exited 2'],
      });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('WORKING');
    expect(v.outstanding).toEqual(['test X fails']);
  });

  test('rejects a task_id for another goal', () => {
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'wrong-id',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['ok'],
    });
    expect(() => parseVerdictFromJudge(text, 'goal-123')).toThrow(
      'task_id mismatch',
    );
  });

  test('throws on empty response', () => {
    expect(() => parseVerdictFromJudge('', 'goal-123')).toThrow(
      'empty response',
    );
  });

  test('throws on no JSON object', () => {
    expect(() => parseVerdictFromJudge('no json here', 'goal-123')).toThrow(
      'no JSON object',
    );
  });

  test('throws on invalid verdict (COMPLETE with outstanding)', () => {
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: ['still work'],
      evidence: ['evidence'],
    });
    expect(() => parseVerdictFromJudge(text, 'goal-123')).toThrow();
  });

  test('extracts the LAST verdict when multiple JSON objects are present', () => {
    const working = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'WORKING',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: ['test X fails'],
      evidence: ['gmake check exited 2'],
    });
    const complete = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['gmake check exited 0'],
    });
    // Greedy matching merges both objects into an invalid string; the parser
    // must isolate and extract the final verdict.
    const text = `Previous attempt: ${working} Final verdict: ${complete}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.evidence).toEqual(['gmake check exited 0']);
  });

  test('extracts JSON when a string value contains braces', () => {
    // The quote-aware scanner prevents inner braces from prematurely closing the object.
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['function {return true} passes'],
    });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.evidence).toEqual(['function {return true} passes']);
  });

  test('extracts JSON when a string value contains unbalanced braces', () => {
    // Skips unmatched braces inside string literals when locating opening and closing delimiters.
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['config { incomplete, see file'],
    });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.evidence).toEqual(['config { incomplete, see file']);
  });

  test('extracts JSON when trailing prose contains braces', () => {
    const json = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['all good'],
    });
    const text = `${json} Note: rule {2} applies to {this} case.`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
  });

  test('extracts JSON with nested objects in string values', () => {
    // The scanner collects all balanced brace pairs; outer candidate objects
    // are evaluated before nested sub-structures.
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'WORKING',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: ['config {"key": {"nested": true}} is wrong'],
      evidence: ['found {"a": {"b": {"c": 1}}} in output'],
    });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('WORKING');
    expect(v.outstanding).toEqual([
      'config {"key": {"nested": true}} is wrong',
    ]);
  });

  test('skips an invalid first object and returns the valid second', () => {
    const invalid = '{not valid json}';
    const valid = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['ok'],
    });
    const text = `${invalid} ${valid}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
  });

  test('handles escaped quotes inside JSON string values', () => {
    const text = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['he said "done {really}"'],
    });
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.evidence).toEqual(['he said "done {really}"']);
  });

  test('extracts the last valid object when prose has unbalanced braces', () => {
    const json = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['ok'],
    });
    const text = `Analysis { incomplete\nFinal: ${json}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
  });

  test('extracts JSON when prose has an odd number of quotes before the JSON', () => {
    // When LLM prose contains unmatched quotes (e.g., `I got a "file not found error.`),
    // the scanner's inString state would invert without a newline reset, treating
    // subsequent JSON structural braces as string literals.
    const json = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['all checks pass'],
    });
    const text = `I got a "file not found error.\nFinal verdict:\n${json}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
    expect(v.evidence).toEqual(['all checks pass']);
  });

  test('extracts JSON when prose has multiple odd-quote segments separated by newlines', () => {
    const json = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'WORKING',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: ['tests still failing'],
      evidence: ['gmake check exited 2'],
    });
    const text = `Checking "this thing.\nAlso "that thing.\nVerdict:\n${json}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('WORKING');
  });

  test('extracts JSON from gmake-style output with logging before the verdict', () => {
    // Build targets may output recipe echoes or progress logs before printing
    // the JSON verdict. The parser must isolate the verdict from preceding output.
    const json = JSON.stringify({
      schema_version: 1,
      task_id: 'goal-123',
      state: 'COMPLETE',
      candidate: 'abc1234',
      fingerprint: 'deadbeef',
      outstanding: [],
      evidence: ['gmake check exited 0'],
    });
    const text = `Making completion-gate-json in /project\nRunning tests...\n${json}`;
    const v = parseVerdictFromJudge(text, 'goal-123');
    expect(v.state).toBe('COMPLETE');
  });
});

describe('buildVerdictPrompt', () => {
  test('includes the goal objective and candidate identity', () => {
    const prompt = buildVerdictPrompt(makeGoal(), "I'm done", candidate);
    expect(prompt).toContain('fix the tests');
    expect(prompt).toContain('abc1234');
    expect(prompt).toContain('deadbeef');
  });

  test('includes the classification rules for all 5 states', () => {
    const prompt = buildVerdictPrompt(makeGoal(), '', candidate);
    expect(prompt).toContain('COMPLETE');
    expect(prompt).toContain('WORKING');
    expect(prompt).toContain('BLOCKED');
    expect(prompt).toContain('NEEDS_INPUT');
    expect(prompt).toContain('CANCELLED');
  });

  test('includes the JSON schema instruction', () => {
    const prompt = buildVerdictPrompt(makeGoal(), '', candidate);
    expect(prompt).toContain('schema_version');
    expect(prompt).toContain('task_id');
    expect(prompt).toContain('candidate');
    expect(prompt).toContain('fingerprint');
    expect(prompt).toContain('outstanding');
    expect(prompt).toContain('evidence');
  });

  test("includes the goal's task_id for echoing", () => {
    const prompt = buildVerdictPrompt(makeGoal(), '', candidate);
    expect(prompt).toContain('goal-123');
  });

  test('includes ordered mode for a sequenced goal', () => {
    const goal = makeGoal();
    goal.mode = 'ordered';
    const prompt = buildVerdictPrompt(goal, '', candidate);
    expect(prompt).toContain('<execution_mode>ordered</execution_mode>');
  });
});

/**
 * Model verifiers exhibit an asymmetric error distribution: they identify false
 * claims significantly more reliably than confirming true ones. The prompt is
 * explicitly structured for falsification to prevent rubber-stamping.
 */
describe('verdict prompt is falsification-first', () => {
  test('it instructs the judge to try to falsify, and not to trust the claim', () => {
    const goal = createGoalState('session-1', 'Ship the release', {
      goalId: 'g1',
      runId: 'r1',
    });
    const prompt = buildVerdictPrompt(goal, 'I am done.', {
      candidate: 'abc123',
      fingerprint: 'fp1',
    });
    expect(prompt).toContain('FALSIFY');
    expect(prompt).toContain("Do not accept the assistant's word");
    // Prompt injection defense: assistant claims are treated as data, not instructions.
    expect(prompt).toContain('not instructions');
  });

  test('the falsification framing did not weaken the output contract', () => {
    const goal = createGoalState('session-1', 'Ship the release', {
      goalId: 'g1',
      runId: 'r1',
    });
    const prompt = buildVerdictPrompt(goal, 'done', {
      candidate: 'abc',
      fingerprint: 'fp',
    });
    expect(prompt).toContain('"schema_version":1');
    expect(prompt).toContain('evidence MUST have at least one entry');
    expect(prompt).toContain('outstanding MUST be empty');
  });
});

describe('verifier child-session isolation', () => {
  function makeClient(child: unknown): {
    session: Record<string, (...args: unknown[]) => Promise<unknown>>;
  } {
    return {
      session: {
        create: async () => child,
        get: async (arg: unknown) => {
          const rec = arg as {sessionID?: string; path?: {id?: string}} | null;
          const id = rec?.sessionID ?? rec?.path?.id;
          if (id === 'session-1') {
            return {
              id: 'session-1',
              location: {directory: '/target/workspace'},
              permissions: [],
            };
          }
          return child;
        },
        prompt: async () => ({
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal-123',
                state: 'WORKING',
                outstanding: ['not done'],
                evidence: ['looked'],
              }),
            },
          ],
        }),
        delete: async () => ({}),
        abort: async () => ({}),
        messages: async () => [],
      },
    };
  }

  const verdictArgs = {
    cwd: '/target/workspace',
    taskId: 'goal-123',
    candidateIdentity: {candidate: 'c', fingerprint: 'f'},
    goal: createGoalState('session-1', 'Ship the release', {
      goalId: 'goal-123',
      runId: 'r1',
    }),
    latestText: 'Done',
  };

  test('verifier rejects a child whose actual workspace differs from the goal cwd', async () => {
    const wrong = {
      id: 'child-1',
      parentID: 'session-1',
      agent: 'goal-verify',
      location: {directory: '/other/workspace'},
    };
    const verifier = createChildSessionVerifier(makeClient(wrong), {});
    await expect(verifier(verdictArgs as never)).rejects.toThrow(
      /location|workspace/i,
    );
  });

  test('verifier rejects a child running under an unexpected agent', async () => {
    const wrong = {
      id: 'child-1',
      parentID: 'session-1',
      agent: 'build',
      location: {directory: '/target/workspace'},
    };
    const verifier = createChildSessionVerifier(makeClient(wrong), {});
    await expect(verifier(verdictArgs as never)).rejects.toThrow(/agent/i);
  });

  test('verifier rejects a child with no readable location', async () => {
    const wrong = {id: 'child-1', parentID: 'session-1', agent: 'goal-verify'};
    const verifier = createChildSessionVerifier(makeClient(wrong), {});
    await expect(verifier(verdictArgs as never)).rejects.toThrow(
      /location|workspace/i,
    );
  });

  test('verifier accepts a v1 child whose workspace is a top-level directory', async () => {
    const child = {
      id: 'child-v1',
      parentID: 'session-1',
      agent: 'goal-verify',
      directory: '/target/workspace',
    };
    const client = makeClient(child);
    const deleted: string[] = [];
    const captureDeleteInput = (input: unknown): void => {
      const record = input as {
        sessionID?: unknown;
        path?: {id?: unknown};
        body?: {sessionID?: unknown};
      };
      deleted.push(
        String(
          record.sessionID ?? record.path?.id ?? record.body?.sessionID ?? '',
        ),
      );
    };
    client.session.delete = async input => {
      captureDeleteInput(input);
      return {};
    };
    const verdict = await createChildSessionVerifier(
      client,
      {},
    )(verdictArgs as never);
    expect(verdict.state).toBe('WORKING');
    expect(deleted).toEqual(['child-v1']);
  });

  test('verifier deletes a child created after timeout even when get fails', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const deleted: string[] = [];
    let getCalls = 0;
    const captureDeleteInput = (input: unknown): void => {
      const record = input as {
        sessionID?: unknown;
        path?: {id?: unknown};
        body?: {sessionID?: unknown};
      };
      deleted.push(
        String(
          record.sessionID ?? record.path?.id ?? record.body?.sessionID ?? '',
        ),
      );
    };
    const client = {
      session: {
        create: async () =>
          await new Promise<unknown>(resolve => {
            resolveCreate = resolve;
          }),
        get: async (arg: unknown) => {
          if (verifierSessionID(arg) === 'session-1')
            return verifierSessionInfo(arg, '/target/workspace');
          getCalls += 1;
          throw new Error('lookup failed');
        },
        prompt: async () => ({}),
        delete: async (input: unknown) => {
          captureDeleteInput(input);
          return {};
        },
        abort: async () => ({}),
        messages: async () => [],
      },
    };
    const verdictPromise = createChildSessionVerifier(client, {timeoutMs: 5})(
      verdictArgs as never,
    );
    const timedOut = expect(verdictPromise).rejects.toThrow(/timed out/);
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveCreate?.({id: 'late-child', parentID: 'session-1'});
    await timedOut;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(deleted).toEqual(['late-child']);
    // Child lookups still throw; cleanup uses the retained ID and never
    // consults that path. The one successful lookup reads the parent policy
    // before creation.
    expect(getCalls).toBe(0);
  });

  test('verifier deletes a late-created child whose location is invalid', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    const deleted: string[] = [];
    const captureDeleteInput = (input: unknown): void => {
      const record = input as {
        sessionID?: unknown;
        path?: {id?: unknown};
        body?: {sessionID?: unknown};
      };
      deleted.push(
        String(
          record.sessionID ?? record.path?.id ?? record.body?.sessionID ?? '',
        ),
      );
    };
    const client = {
      session: {
        create: async () =>
          await new Promise<unknown>(resolve => {
            resolveCreate = resolve;
          }),
        get: async (arg: unknown) => {
          const rec = arg as {sessionID?: string; path?: {id?: string}} | null;
          if ((rec?.sessionID ?? rec?.path?.id) === 'session-1') {
            return {
              id: 'session-1',
              location: {directory: '/target/workspace'},
              permissions: [],
            };
          }
          return {id: 'late-child', parentID: 'session-1'};
        },
        prompt: async () => ({}),
        delete: async (input: unknown) => {
          captureDeleteInput(input);
          return {};
        },
        abort: async () => ({}),
        messages: async () => [],
      },
    };
    const verdictPromise = createChildSessionVerifier(client, {timeoutMs: 5})(
      verdictArgs as never,
    );
    const timedOut = expect(verdictPromise).rejects.toThrow(/timed out/);
    await new Promise(resolve => setTimeout(resolve, 10));
    resolveCreate?.({id: 'late-child', parentID: 'session-1'});
    await timedOut;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(deleted).toEqual(['late-child']);
  });

  test('verifier child is created with an explicit restrictive session permission policy', async () => {
    // On v2 hosts a parent-bound child inherits the parent session's permission
    // rules and the host applies session rules AFTER agent rules (last match
    // wins), so a permissive parent would override the verifier agent's denies
    // unless the child carries its own restrictive policy.
    let capturedCreateInput: Record<string, unknown> | undefined;
    let capturedCreateBody: Record<string, unknown> | undefined;
    const client = {
      session: {
        create: async (input: unknown) => {
          const i = input as Record<string, unknown>;
          // The SDK shim calls create either flat ({...body}) or legacy
          // ({body}); capture whichever carries the fields.
          if (i.body && typeof i.body === 'object') {
            capturedCreateBody = i.body as Record<string, unknown>;
          } else {
            capturedCreateInput = i;
          }
          return {id: 'child-1', parentID: 'session-1'};
        },
        get: async (arg: unknown) => {
          const rec = arg as {sessionID?: string; path?: {id?: string}} | null;
          if ((rec?.sessionID ?? rec?.path?.id) === 'session-1') {
            return {
              id: 'session-1',
              location: {directory: '/target/workspace'},
              permissions: [],
            };
          }
          return {
            id: 'child-1',
            parentID: 'session-1',
            location: {directory: '/target/workspace'},
          };
        },
        prompt: async () => ({
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal-123',
                state: 'WORKING',
                outstanding: ['not done'],
                evidence: ['looked'],
              }),
            },
          ],
        }),
        delete: async () => ({}),
        abort: async () => ({}),
        messages: async () => [],
      },
    };
    const verifier = createChildSessionVerifier(client, {});
    await verifier({
      cwd: '/target/workspace',
      taskId: 'goal-123',
      candidateIdentity: {candidate: 'c', fingerprint: 'f'},
      goal: createGoalState('session-1', 'Ship the release', {
        goalId: 'goal-123',
        runId: 'r1',
      }),
      latestText: 'Done',
    } as never);
    const perms = (capturedCreateInput ?? capturedCreateBody)?.permissions as
      Array<{action: string; resource: string; effect: string}> | undefined;
    expect(Array.isArray(perms)).toBe(true);
    // deny-all must be present and ordered FIRST so it cannot be overridden by
    // later rules; mutation actions must be denied.
    expect(perms![0]).toEqual({action: '*', resource: '*', effect: 'deny'});
    for (const action of ['edit', 'write', 'patch', 'bash']) {
      const rule = perms!.findLast(
        r => r.action === action || r.action === '*',
      );
      expect(rule?.effect).toBe('deny');
    }
    // The policy must equal the shared VERIFIER_SESSION_PERMISSIONS constant.
    expect(perms).toEqual(VERIFIER_SESSION_PERMISSIONS.map(r => ({...r})));
  });
});
