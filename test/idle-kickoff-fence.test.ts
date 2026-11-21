import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  acquirePromptInFlight,
  retainKickoffDispatch,
  removeKickoffDispatch,
} from '../src/session-runtime.ts';
import {deserializeGoal, serializeGoal} from '../src/persistence.ts';
import {readWalEntries, recoverState} from '../src/persistence-wal.ts';
import {sessionStatePaths} from '../src/session-paths.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';

function retainInputs(
  f: ReturnType<typeof createIdleStateFixture>,
  inFlight = false,
) {
  const goal = f.machine.snapshot();
  const pending = {
    goalId: goal.goalId,
    runId: goal.runId,
    dispatch: {
      method: 'prompt',
      payload: {files: [{path: 'required-spec.md'}]},
    },
    inFlight,
  };
  retainKickoffDispatch(f.runtime, goal.sessionID, pending);
  return pending;
}

for (const inFlight of [false, true]) {
  test(`idle waits for retained kickoff inputs while admission is ${inFlight ? 'in flight' : 'awaiting retry'}`, async () => {
    const f = createIdleStateFixture();
    const pending = retainInputs(f, inFlight);
    f.setMessages([
      idleAssistant('unrelated-turn', 'Working on another objective.', 10),
    ]);
    for (let i = 0; i < 3; i++) {
      await f.hooks.event!({
        type: 'session.idle',
        sessionID: f.session.sessionID,
        id: `idle-${i}`,
      });
    }
    expect(f.prompts).toHaveLength(0);
    expect(f.machine.snapshot()).toMatchObject({
      status: 'active',
      lastAssistantMessageID: '',
      noProgressTurns: 0,
      noToolCallTurns: 0,
    });
    expect(f.errors).toEqual([]);
    // Once the original payload has been admitted, ordinary idle can drive.
    removeKickoffDispatch(f.runtime, f.session.sessionID, pending);
    await f.idle();
    expect(f.prompts).toHaveLength(1);
  });
}

test('another goal, another session, or an old run cannot fence this goal', async () => {
  for (const changed of ['goal', 'session', 'run']) {
    const f = createIdleStateFixture();
    const goal = f.machine.snapshot();
    retainKickoffDispatch(
      f.runtime,
      changed === 'session' ? 'another-session' : goal.sessionID,
      {
        goalId: changed === 'goal' ? 'another-goal' : goal.goalId,
        runId: changed === 'run' ? 'previous-run' : goal.runId,
        dispatch: {method: 'prompt', payload: {files: [{path: 'other.md'}]}},
      },
    );
    f.setMessages([idleAssistant('current', 'I made progress.', 100)]);
    await f.idle();
    expect(f.prompts).toHaveLength(1);
    expect(f.machine.snapshot().status).toBe('active');
  }
});

for (const text of ['stop', 'Please work on the documentation first.']) {
  test(`retained inputs still allow human intervention: ${text}`, async () => {
    const f = createIdleStateFixture();
    retainInputs(f);
    f.setMessages([
      idleAssistant('old', 'Working.', 100),
      {id: 'human', role: 'user', parts: [{type: 'text', text}]},
    ]);
    await f.hooks.event!({
      type: 'session.idle',
      sessionID: f.session.sessionID,
      id: 'human-intervention-idle',
    });
    expect(f.machine.snapshot().status).toBe('paused');
    expect(f.machine.snapshot().stopReason).toBe(
      text === 'stop' ? 'explicit pause' : 'user intervention',
    );
    expect(f.prompts).toHaveLength(0);
    expect(
      f.runtime.pendingKickoffDispatch
        ?.get(f.session.sessionID)
        ?.has(f.machine.snapshot().goalId),
    ).toBe(true);
  });
}

test('an admission retained during message retrieval is rechecked before driving', async () => {
  const f = createIdleStateFixture();
  let resolveMessages!: (messages: unknown[]) => void;
  f.deps.sessionApi.messages = () =>
    new Promise(resolve => {
      resolveMessages = resolve;
    });
  const idle = f.idle();
  retainInputs(f);
  resolveMessages([idleAssistant('old', 'Unrelated finished work.', 100)]);
  await idle;
  expect(f.prompts).toHaveLength(0);
  expect(f.machine.snapshot().lastAssistantMessageID).toBe('');
});

test('the admission marker survives persistence and ordinary recovery transitions', async () => {
  const original = createIdleStateFixture({kickoffAdmissionPending: true});
  const restored = deserializeGoal(
    JSON.parse(JSON.stringify(serializeGoal(original.machine.snapshot()))),
  );
  expect(restored.kickoffAdmissionPending).toBe(true);
  const f = createIdleStateFixture(restored);
  await f.machine.transition('paused', {
    source: 'recovery',
    stopReason: 'recovery',
  });
  await f.machine.transition('active', {source: 'idle-handler'});
  expect(f.machine.snapshot().kickoffAdmissionPending).toBe(true);
  await f.hooks.event!({
    type: 'session.compacted',
    sessionID: f.session.sessionID,
  });
  expect(f.machine.snapshot().kickoffAdmissionPending).toBe(true);
  expect(deserializeGoal({}).kickoffAdmissionPending).toBe(false);
  expect(
    deserializeGoal({kickoffAdmissionPending: 'true'}).kickoffAdmissionPending,
  ).toBe(false);
});

test('the first restored idle pauses with a resubmit receipt when inputs were lost', async () => {
  const original = createIdleStateFixture({kickoffAdmissionPending: true});
  const f = createIdleStateFixture(
    deserializeGoal(
      JSON.parse(JSON.stringify(serializeGoal(original.machine.snapshot()))),
    ),
  );
  // Hydration's recovery pause is re-armed by the real event handler.
  await f.machine.transition('paused', {
    source: 'recovery',
    stopReason: 'recovery',
  });
  f.runtime.recoveryPendingSessions.add(f.session.sessionID);
  f.setMessages([idleAssistant('old', 'Unrelated work finished.', 100)]);
  let persisted = 0;
  f.session.persist = async () => {
    persisted++;
    return true;
  };
  for (let i = 0; i < 2; i++)
    await f.hooks.event!({
      type: 'session.idle',
      sessionID: f.session.sessionID,
      id: `restored-idle-${i}`,
    });
  expect(f.machine.snapshot()).toMatchObject({
    status: 'paused',
    stopReason: 'kickoff admission failed',
    kickoffAdmissionPending: true,
    lastAssistantMessageID: '',
  });
  expect(f.prompts).toHaveLength(0);
  expect(f.announcements).toHaveLength(1);
  expect(f.announcements[0]).toContain('original kickoff inputs');
  expect(f.announcements[0]).toContain(
    `/goal resume ${f.machine.snapshot().goalId}`,
  );
  expect(persisted).toBeGreaterThan(0);
  expect(f.errors).toEqual([]);
});

test('the durable marker waits for a matching payload but rejects an old run payload', async () => {
  const f = createIdleStateFixture({kickoffAdmissionPending: true});
  const pending = retainInputs(f);
  f.setMessages([idleAssistant('old', 'Another result.', 100)]);
  await f.idle();
  expect(f.machine.snapshot().status).toBe('active');
  expect(f.announcements).toHaveLength(0);
  removeKickoffDispatch(f.runtime, f.session.sessionID, pending);
  retainKickoffDispatch(f.runtime, f.session.sessionID, {
    ...pending,
    runId: 'previous-run',
  });
  await f.idle();
  expect(f.machine.snapshot().status).toBe('paused');
  expect(f.machine.snapshot().kickoffAdmissionPending).toBe(true);
  expect(f.announcements).toHaveLength(1);
  expect(f.prompts).toHaveLength(0);
});

test('lost kickoff inputs never override the reason for a human pause', async () => {
  for (const text of ['stop', 'Please switch to another module.']) {
    const f = createIdleStateFixture({kickoffAdmissionPending: true});
    f.setMessages([{id: 'human', role: 'user', parts: [{type: 'text', text}]}]);
    await f.idle();
    expect(f.machine.snapshot().status).toBe('paused');
    expect(f.machine.snapshot().stopReason).toBe(
      text === 'stop' ? 'explicit pause' : 'user intervention',
    );
    expect(f.machine.snapshot().kickoffAdmissionPending).toBe(true);
    expect(f.prompts).toHaveLength(0);
    expect(f.announcements.every(m => !m.includes('kickoff inputs'))).toBe(
      true,
    );
  }
});

test('a command still preparing its dispatch does not look like lost recovery inputs', async () => {
  const f = createIdleStateFixture({kickoffAdmissionPending: true});
  const release = acquirePromptInFlight(f.runtime, f.session.sessionID);
  f.setMessages([idleAssistant('old', 'Another result.', 100)]);
  try {
    await f.idle();
    expect(f.machine.snapshot().status).toBe('active');
    expect(f.announcements).toHaveLength(0);
    expect(f.prompts).toHaveLength(0);
  } finally {
    release();
  }
  // If preparation ends without retaining a payload, recovery needs input.
  await f.idle();
  expect(f.machine.snapshot().status).toBe('paused');
  expect(f.machine.snapshot().kickoffAdmissionPending).toBe(true);
  expect(f.announcements).toHaveLength(1);
});

test('the first creation WAL record already contains the pending admission marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-kickoff-recovery-'));
  try {
    const errors: unknown[] = [];
    const manager = new SessionStateManager(
      createRuntimeState(),
      async () => true,
      root,
      undefined,
      new Map(),
      async () => true,
      undefined,
      undefined,
      undefined,
      undefined,
      DEFAULT_GOAL_OPTIONS,
      async (...args) => {
        errors.push(args);
      },
    );
    const machine = manager.createGoal('restart-session', 'Use attached spec', {
      kickoffAdmissionPending: true,
    });
    await manager.pendingWalWrite;
    const {statePath, ledgerPath} = sessionStatePaths(root, 'restart-session');
    const entries = await readWalEntries(ledgerPath);
    expect(entries).toHaveLength(1);
    expect(entries[0].snapshot.kickoffAdmissionPending).toBe(true);
    const restored = await recoverState(statePath, ledgerPath);
    expect(restored.goals).toHaveLength(1);
    expect(restored.goals[0].goalId).toBe(machine.snapshot().goalId);
    expect(restored.goals[0].kickoffAdmissionPending).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('idle re-arms a retained non-exhausted kickoff after a transient fence lifts', async () => {
  const f = createIdleStateFixture({kickoffAdmissionPending: true});
  retainInputs(f);
  const scheduled: Array<{sessionID: string; goalId: string; runId: string}> =
    [];
  f.runtime.canDriveSession = () => true;
  f.runtime.scheduleKickoff = (sessionID, goalId, runId) => {
    scheduled.push({sessionID, goalId, runId});
  };
  f.setMessages([idleAssistant('old', 'Previous turn.', 100)]);
  await f.idle();
  expect(f.machine.snapshot().status).toBe('active');
  expect(scheduled).toHaveLength(1);
  expect(scheduled[0].goalId).toBe(f.machine.snapshot().goalId);
});
