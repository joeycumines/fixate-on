import {describe, expect, test} from 'bun:test';
import {
  createChildSessionJudge,
  createChildSessionVerifier,
} from '../src/child-session-verifier.ts';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {createGoalState} from '../src/state-machine.ts';

function host() {
  const goal = createGoalState('parent', 'Finish the fixture', {
    goalId: 'goal',
  });
  const verdict = JSON.stringify({
    schema_version: 1,
    task_id: goal.goalId,
    state: 'COMPLETE',
    outstanding: [],
    evidence: ['Controlled fixture inspected.'],
  });
  const admission = {
    id: 'input',
    type: 'user',
    sessionID: 'child',
    time: {created: 10},
  };
  const assistant = {
    id: 'answer',
    type: 'assistant',
    agent: 'goal-verify',
    finish: 'stop',
    time: {created: 11, completed: 12},
    content: [{type: 'text', text: verdict}],
  };
  const idle = {
    id: 'idle',
    type: 'idle',
    outcome: 'succeeded',
    time: {created: 13},
  };
  const child = {
    id: 'child',
    parentID: 'parent',
    agent: 'goal-verify',
    location: {directory: '/fixture'},
    outcome: 'succeeded',
    time: {created: 1, busy: 10, idle: 13},
  };
  const rows: unknown[] = [admission, assistant, idle];
  const calls = {removed: 0, context: 0};
  let onPrompt:
    | ((input: {sessionID: string; messageID: string}) => Promise<void>)
    | undefined;
  const ctx = {
    agent: {get: async () => ({id: 'goal-verify', permissions: []})},
    session: {
      create: async () => ({id: 'child', parentID: 'parent'}),
      get: async ({sessionID}: {sessionID: string}): Promise<unknown> =>
        sessionID === 'parent'
          ? {id: 'parent', permissions: [], location: child.location}
          : child,
      switchAgent: async () => {},
      update: async () => {},
      hook: async (_name: string, callback: typeof onPrompt) => {
        onPrompt = callback;
        return {
          dispose: async () => {
            onPrompt = undefined;
          },
        };
      },
      prompt: async (): Promise<unknown> => {
        await onPrompt?.({sessionID: 'child', messageID: admission.id});
        return admission;
      },
      wait: async () => {},
      context: async (): Promise<unknown> => {
        calls.context++;
        return rows;
      },
      remove: async () => {
        calls.removed++;
      },
      interrupt: async () => {},
    },
  };
  return {
    ctx,
    admission,
    assistant,
    idle,
    child,
    rows,
    calls,
    shim: createV2ClientShim(ctx as never, {bySession: new Map()}),
    input: {
      goal,
      taskId: goal.goalId,
      cwd: '/fixture',
      latestText: 'Done',
      candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
    },
  };
}

test('a current successful final response attests COMPLETE and releases its child', async () => {
  const fixture = host();
  const result = await createChildSessionVerifier(fixture.shim)(fixture.input);
  expect(result.state).toBe('COMPLETE');
  expect(fixture.calls).toEqual({removed: 1, context: 1});
});

describe('an idle wait does not turn failed execution into an attestation', () => {
  for (const failurePolicy of ['reject', 'approve'] as const) {
    for (const finish of ['length', 'tool-calls', 'stop']) {
      test(`${finish} text followed by execution failure under ${failurePolicy}`, async () => {
        const fixture = host();
        fixture.assistant.finish = finish;
        fixture.idle.outcome = 'failed';
        Object.assign(fixture.idle, {
          error: {message: 'Execution failed after the assistant step.'},
        });
        fixture.child.outcome = 'failed';
        const result = createChildSessionVerifier(fixture.shim, {
          failurePolicy,
        })(fixture.input);
        if (failurePolicy === 'reject')
          await expect(result).rejects.toThrow(
            'Execution failed after the assistant step.',
          );
        else {
          const verdict = await result;
          expect(verdict.state).toBe('WORKING');
          expect(verdict.outstanding.join(' ')).toContain(
            'Execution failed after the assistant step.',
          );
        }
        expect(fixture.calls.removed).toBe(1);
      });
    }
  }

  test('the legacy judge faults when execution fails after an approved marker', async () => {
    const fixture = host();
    fixture.assistant.content = [{type: 'text', text: '[judge:approved]'}];
    fixture.idle.outcome = 'failed';
    fixture.child.outcome = 'failed';
    const result = await createChildSessionJudge(fixture.shim)({
      goal: fixture.input.goal,
      sessionID: 'parent',
      latestText: 'Done',
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('Child execution failed');
    expect(fixture.calls.removed).toBe(1);
  });
});

const invalidSettlements: Array<{
  name: string;
  change: (fixture: ReturnType<typeof host>) => void;
  error: string;
}> = [
  {
    name: 'interrupted execution',
    change: f => {
      f.idle.outcome = f.child.outcome = 'interrupted';
    },
    error: 'Child execution interrupted',
  },
  {
    name: 'a successful older idle while the current execution failed',
    change: f => {
      f.child.outcome = 'failed';
    },
    error: 'no current successful settlement',
  },
  {
    name: 'a successful older idle while the current execution is running',
    change: f => {
      f.child.time.busy = 14;
    },
    error: 'no current successful settlement',
  },
  {
    name: 'a stale context with a newer successful settlement in the same clock tick',
    change: f => {
      f.child.time.idle++;
    },
    error: 'no current successful settlement',
  },
  {
    name: 'missing authoritative execution outcome',
    change: f => {
      Reflect.deleteProperty(f.child, 'outcome');
    },
    error: 'no current successful settlement',
  },
  {
    name: 'missing admitted input in a stale context',
    change: f => {
      f.rows.shift();
    },
    error: 'does not contain the admitted input',
  },
  {
    name: 'missing current execution idle marker',
    change: f => {
      f.rows.pop();
    },
    error: 'no completed idle boundary',
  },
  {
    name: 'a new assistant after the previous successful idle',
    change: f => {
      f.rows.push({...f.assistant, id: 'later'});
    },
    error: 'no completed idle boundary',
  },
  {
    name: 'an empty succeeding execution after a failed assistant turn',
    change: f => {
      f.rows.splice(2, 0, {...f.idle, outcome: 'failed'});
    },
    error: 'no final assistant for this input',
  },
  {
    name: 'a subsequent user input supersedes the verifier prompt',
    change: f => {
      f.rows.splice(1, 0, {...f.admission, id: 'other'});
    },
    error: 'superseded by another user input',
  },
  {
    name: 'a receipt for another session',
    change: f => {
      f.admission.sessionID = 'other';
    },
    error: 'admission identity is unavailable',
  },
  {
    name: 'a new synthetic input with no completed assistant',
    change: f => {
      f.rows.push({type: 'synthetic', id: 'new-input'});
    },
    error: 'no completed idle boundary',
  },
  {
    name: 'no final assistant completion timestamp',
    change: f => {
      Reflect.deleteProperty(f.assistant.time, 'completed');
    },
    error: 'did not finish before execution settled',
  },
  {
    name: 'a final reply from another agent despite restored session selection',
    change: f => {
      f.assistant.agent = 'build';
    },
    error: 'ran under agent build',
  },
  {
    name: 'an empty final assistant after interim COMPLETE',
    change: f => {
      f.rows.splice(2, 0, {...f.assistant, id: 'empty', content: []});
    },
    error: 'final assistant contains no verdict',
  },
];

for (const scenario of invalidSettlements) {
  test(`rejects ${scenario.name}`, async () => {
    const fixture = host();
    scenario.change(fixture);
    await expect(
      createChildSessionVerifier(fixture.shim)(fixture.input),
    ).rejects.toThrow(scenario.error);
    expect(fixture.calls.removed).toBe(1);
  });
}

test('host continuations can reach a current successful final attestation', async () => {
  const fixture = host();
  fixture.rows.splice(
    1,
    0,
    {...fixture.assistant, id: 'truncated', finish: 'length'},
    {type: 'synthetic', id: 'continue'},
  );
  expect(
    (await createChildSessionVerifier(fixture.shim)(fixture.input)).state,
  ).toBe('COMPLETE');
  expect(fixture.calls.removed).toBe(1);
});

test('same-millisecond terminals use the host monotonic idle stamp', async () => {
  const fixture = host();
  fixture.rows.splice(
    1,
    0,
    {...fixture.assistant, id: 'earlier'},
    {...fixture.idle, id: 'earlier-idle', outcome: 'failed'},
  );
  fixture.assistant.time = {created: 13, completed: 13};
  fixture.child.time = {created: 1, busy: 13, idle: 14};
  expect(
    (await createChildSessionVerifier(fixture.shim)(fixture.input)).state,
  ).toBe('COMPLETE');
});

for (const finish of [
  'length',
  'tool-calls',
  'unknown',
  'content-filter',
  'error',
]) {
  test(`a successful idle cannot bless an unfinished ${finish} assistant`, async () => {
    const fixture = host();
    fixture.assistant.finish = finish;
    await expect(
      createChildSessionVerifier(fixture.shim)(fixture.input),
    ).rejects.toThrow(`Child assistant failed: ${finish}`);
    expect(fixture.calls.removed).toBe(1);
  });
}
