import {expect, test} from 'bun:test';
import {createHooks} from '../src/hooks.ts';
import {validatePendingIntent} from '../src/continuation-loop.ts';
import {DEFAULT_GOAL_OPTIONS} from '../src/session-runtime.ts';
import {handleUpdateGoal} from '../src/tools.ts';
import {handleCommand} from '../src/commands.ts';
import type {PendingIntent} from '../src/state-machine.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';
import {deferred, waitFor} from './wait-for.ts';

for (const resume of [false, true]) {
  test(`a successful read begun before ${resume ? 'resume' : 'pause'} cannot update or drive the newer state`, async () => {
    const fixture = createIdleStateFixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    fixture.deps.sessionApi.messages = async () => {
      entered.resolve();
      await release.promise;
      return [
        idleAssistant('old-turn', 'Output from the preceding run window.', 100),
      ];
    };
    const idle = fixture.idle();
    await entered.promise;
    await handleCommand('pause', fixture.session);
    if (resume) await handleCommand('resume', fixture.session);
    const current = fixture.machine.snapshot();
    release.resolve();
    await idle;
    const after = fixture.machine.snapshot();
    expect(after).toMatchObject({
      revision: current.revision,
      status: current.status,
      turnCount: current.turnCount,
      noProgressTurns: current.noProgressTurns,
      noToolCallTurns: current.noToolCallTurns,
      lastAssistantText: current.lastAssistantText,
      lastAssistantMessageID: current.lastAssistantMessageID,
      lastCountedProgressMessageID: current.lastCountedProgressMessageID,
      lastNoToolCallMessageID: current.lastNoToolCallMessageID,
    });
    // Actual spend is still accounted for even though its idle decision is stale.
    expect(after.usage.input).toBe(100);
    expect(after.usage.output).toBe(100);
    expect(fixture.prompts).toHaveLength(0);
    expect(fixture.announcements).toHaveLength(0);
  });
}

test('a poller read begun before resume cannot charge the resumed run', async () => {
  const fixture = createIdleStateFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  let reads = 0;
  fixture.deps.sessionApi.messages = async () => {
    if (++reads > 1) return [];
    entered.resolve();
    await release.promise;
    throw new Error('read from before resume failed');
  };
  createHooks({
    ...fixture.deps,
    idlePoller: true,
    idlePollerIntervalMs: 2,
    idleQuietMs: 0,
    idleGraceMs: 0,
    defaultOpts: {...DEFAULT_GOAL_OPTIONS, maxPromptFailures: 1},
  });
  try {
    await entered.promise;
    await handleCommand('pause', fixture.session);
    await handleCommand('resume', fixture.session);
    const resumed = fixture.machine.snapshot();
    release.resolve();
    await waitFor(
      () => reads > 1 || fixture.announcements.length > 0,
      'failed read processed',
    );
    expect(fixture.machine.snapshot()).toEqual(resumed);
    expect(fixture.announcements).toHaveLength(0);
  } finally {
    fixture.runtime.disposed = true;
    release.resolve();
  }
});

test('the default three-failure poller bound counts only failures from the resumed window', async () => {
  const fixture = createIdleStateFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  let reads = 0;
  fixture.deps.sessionApi.messages = async () => {
    if (++reads === 1) {
      entered.resolve();
      await release.promise;
    }
    throw new Error('read failed');
  };
  createHooks({
    ...fixture.deps,
    idlePoller: true,
    idlePollerIntervalMs: 2,
    idleQuietMs: 0,
    idleGraceMs: 0,
  });
  try {
    await entered.promise;
    await handleCommand('pause', fixture.session);
    await handleCommand('resume', fixture.session);
    release.resolve();
    await waitFor(
      () => fixture.announcements.length > 0,
      'bounded read failure pause',
    );
    expect(reads - 1).toBe(3);
  } finally {
    fixture.runtime.disposed = true;
    release.resolve();
  }
});

test('discarding a stale native idle read preserves a newer completion intent revision', async () => {
  const fixture = createIdleStateFixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  fixture.deps.sessionApi.messages = async () => {
    entered.resolve();
    await release.promise;
    throw new Error('old native idle read failed');
  };
  const idle = fixture.idle();
  await entered.promise;
  await fixture.machine.transition('paused', {source: 'slash-command'});
  await fixture.machine.transition('active', {source: 'slash-command'});
  const current = fixture.machine.snapshot();
  const intent = {
    goalId: current.goalId,
    runId: current.runId,
    revision: current.revision,
    targetStatus: 'complete' as const,
    messageID: '',
    toolCallID: '',
    evidence: '',
    createdAt: Date.now(),
  };
  expect(validatePendingIntent(intent, current).valid).toBe(true);
  release.resolve();
  await idle;
  const after = fixture.machine.snapshot();
  expect(after).toEqual(current);
  expect(validatePendingIntent(intent, after).valid).toBe(true);
});

for (const failsFirstRead of [false, true]) {
  test(`completion intent survives ${failsFirstRead ? 'one transient failed read' : 'a successful read (control)'}`, async () => {
    const fixture = createIdleStateFixture();
    let pending: PendingIntent | null = null;
    fixture.session.setPendingIntent = (_goalID, intent) => {
      pending = intent;
    };
    fixture.session.getPendingIntent = () => pending;
    fixture.session.getAllPendingIntents = () => (pending ? [pending] : []);
    let judgments = 0;
    fixture.deps.completionJudge = async () => {
      judgments++;
      return {approved: true, reason: 'Requested work is complete'};
    };
    let reads = 0;
    fixture.deps.sessionApi.messages = async () => {
      if (++reads === 1 && failsFirstRead)
        throw new Error('temporary read outage');
      return [
        idleAssistant('complete-turn', 'Requested work is complete.', 100),
      ];
    };
    const result = JSON.parse(
      await handleUpdateGoal(fixture.session, {status: 'complete'}),
    );
    expect(result.pendingCompletion).toBe(true);
    expect(pending).not.toBeNull();
    const requested = fixture.machine.snapshot();
    await fixture.idle();
    if (failsFirstRead) {
      expect(fixture.machine.state.revision).toBe(requested.revision);
      expect(
        validatePendingIntent(pending!, fixture.machine.snapshot()).valid,
      ).toBe(true);
      await fixture.idle();
    }
    expect(judgments).toBe(1);
    expect(fixture.machine.state.status).toBe('complete');
    expect(pending).toBeNull();
    expect(fixture.prompts).toHaveLength(0);
  });
}
