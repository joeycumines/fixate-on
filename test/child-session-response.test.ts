import {expect, test} from 'bun:test';
import {extractChildVerdictText} from '../src/child-session-response.ts';
import {createChildSessionVerifier} from '../src/child-session-verifier.ts';
import {createGoalState} from '../src/state-machine.ts';

const parts = [{type: 'text', text: '[judge:approved]'}];

test('older synchronous clients retain their completed string and parts contracts', () => {
  expect(extractChildVerdictText('[judge:approved]')).toBe('[judge:approved]');
  expect(extractChildVerdictText({parts})).toBe('[judge:approved]');
  expect(extractChildVerdictText({data: {parts, info: {finish: 'stop'}}})).toBe(
    '[judge:approved]',
  );
});

for (const finish of [
  'length',
  'tool-calls',
  'error',
  'content-filter',
  'unknown',
]) {
  for (const wrapped of [false, true]) {
    test(`legacy ${wrapped ? 'enveloped' : 'direct'} ${finish} cannot attest retained text`, () => {
      const message = {parts, info: {finish}};
      expect(() =>
        extractChildVerdictText(wrapped ? {data: message} : message),
      ).toThrow(`Child assistant failed: ${finish}`);
    });
  }
}

test('an info object cannot mask a failure recorded on the response itself', () => {
  expect(() =>
    extractChildVerdictText({
      parts,
      info: {finish: 'stop'},
      error: {message: 'Failed after text.'},
    }),
  ).toThrow('Failed after text.');
});

for (const failurePolicy of ['reject', 'approve'] as const) {
  test(`v1 truncated COMPLETE is an operational fault under ${failurePolicy}`, async () => {
    const goal = createGoalState('parent', 'Check the fixture', {
      goalId: 'goal',
    });
    let deleted = 0;
    const client = {
      session: {
        create: async () => ({id: 'child', parentID: 'parent'}),
        prompt: async () => ({
          info: {role: 'assistant', finish: 'length'},
          parts: [
            {
              type: 'text',
              text: JSON.stringify({
                schema_version: 1,
                task_id: 'goal',
                state: 'COMPLETE',
                outstanding: [],
                evidence: ['Truncated controlled response.'],
              }),
            },
          ],
        }),
        delete: async () => {
          deleted++;
        },
      },
    };
    const running = createChildSessionVerifier(client, {failurePolicy})({
      goal,
      taskId: goal.goalId,
      latestText: 'Done',
      cwd: '/fixture',
      candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
    });
    if (failurePolicy === 'reject')
      await expect(running).rejects.toThrow('Child assistant failed: length');
    else {
      const result = await running;
      expect(result.state).toBe('WORKING');
      expect(result.outstanding.join(' ')).toContain(
        'Child assistant failed: length',
      );
    }
    expect(deleted).toBe(1);
  });
}
