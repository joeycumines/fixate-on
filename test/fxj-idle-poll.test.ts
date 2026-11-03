// fxj-idle-poll.test.ts — FX-J locks: the continuation loop must wake on
// hosts that never deliver idle events (stock opencode 1.18.19 delivers ZERO
// events to the plugin event hook — R2, confirmed by probe-plugin evidence),
// plus the POL batch from the reset reviews (deferCounts GC, honest
// defer-pause stop reason, pressure-rung reset on resume, idempotent tool
// registration retry, sub-second watchdog wording).
import {describe, expect, test} from 'bun:test';
import {waitFor} from './wait-for.ts';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createHooks,
  type HookDeps,
  type SessionApi,
  type SessionContext,
} from '../src/hooks.ts';
import {
  createRuntimeState,
  DEFAULT_GOAL_OPTIONS,
  SessionStateManager,
} from '../src/session-state-manager.ts';
import type {GoalState} from '../src/state-machine.ts';
import {createGoalState, GoalStateMachine} from '../src/state-machine.ts';
import type {UsageSnapshot} from '../src/accounting.ts';
import {createLoopPolicy} from '../src/continuation-loop.ts';
import {createIdlePoller, evaluateQuietWindow} from '../src/idle-poll.ts';
import {watchdogTimeoutMessage} from '../src/tui-action-labels.ts';

/** No session was read at startup, so no fence was recovered. */
const EMPTY_INVALIDATION: ReadonlyMap<string, readonly string[]> = new Map();

/** Every session is writable in these fixtures: the lease and the sequence seeding are
 * decided by the composition root, and these tests exercise the manager directly. */
const CAN_WRITE_ANY = async (): Promise<boolean> => true;

function makeUsage(): UsageSnapshot {
  return {
    input: 1000,
    output: 500,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costKnown: false,
  };
}

function makeActiveGoal(sessionID = 'session-1'): GoalState {
  const goal = createGoalState(sessionID, 'Build the feature', {
    goalId: 'goal-1',
    runId: 'run-1',
    maxTokens: 200000,
    maxTurns: 25,
    tokenBudget: 50000,
  });
  return {...goal, usage: makeUsage(), status: 'active', turnCount: 1};
}

function makeSessionContext(
  machine: GoalStateMachine,
  additionalMachines: GoalStateMachine[] = [],
): SessionContext {
  const machines = [machine, ...additionalMachines];
  return {
    sessionID: machine.state.sessionID,
    getMachine: () => machine,
    listMachines: () => machines,
    listActiveGoals: () => machines.map(entry => entry.snapshot()),
    listArchivedResults: () => [],
    createGoal: () => machine,
    replaceGoals: async () => machine,
    removeGoal: async () => {},
    clearSession: () => {},
    focusGoal: async () => ({ok: true as const, machine}),
    addOrderedSession: () => {},
    isOrdered: () => false,
    setPendingIntent: () => {},
    getPendingIntent: (_goalId: string) => null,
    getAllPendingIntents: () => [],
    persist: async () => true,
  };
}

function makeMockSessionApi(
  messages: unknown[] = [],
): SessionApi & {promptsSent: Array<{text: string}>} {
  const promptsSent: Array<{text: string}> = [];
  return {
    messages: async () => messages,
    promptAsync: async (_sessionID: string, input: {parts: unknown[]}) => {
      promptsSent.push({text: (input.parts[0] as {text?: string})?.text ?? ''});
      return {};
    },
    promptsSent,
  } as SessionApi & {promptsSent: Array<{text: string}>};
}

function makeWrappedAssistantMessages(): unknown[] {
  return [
    {id: 'm0', role: 'user', parts: [{type: 'text', text: 'go'}]},
    {
      id: 'm1',
      role: 'assistant',
      parts: [{type: 'text', text: 'made progress'}],
    },
  ];
}

function makeDeps(session: SessionContext, sessionApi: SessionApi): HookDeps {
  return {
    getSessionContext: () => session,
    getLoopPolicy: () => createLoopPolicy(),
    commandName: 'goal',
    sessionApi,
    logError: async () => {},
    completionGate: null,
    runtime: {
      ...createRuntimeState(),
      threadToolsRegistered: true,
      promptInFlightSessions: new Set<string>(),
    },
  } as unknown as HookDeps;
}

describe('evaluateQuietWindow (FX-J stability gate)', () => {
  const QUIET = 10_000;

  test('first sight opens the window without firing', () => {
    const r = evaluateQuietWindow(undefined, 1_000, 'm1:500', QUIET);
    expect(r.fire).toBe(false);
    expect(r.next).toEqual({key: 'm1:500', since: 1_000});
  });

  test('unchanged fingerprint inside the window does not fire and keeps since', () => {
    const r = evaluateQuietWindow(
      {key: 'm1:500', since: 1_000},
      9_000,
      'm1:500',
      QUIET,
    );
    expect(r.fire).toBe(false);
    expect(r.next.since).toBe(1_000);
  });

  test('unchanged fingerprint past the window fires and re-arms', () => {
    const r = evaluateQuietWindow(
      {key: 'm1:500', since: 1_000},
      11_000,
      'm1:500',
      QUIET,
    );
    expect(r.fire).toBe(true);
    expect(r.next.since).toBe(11_000);
  });

  test('a changed fingerprint resets the window (host mid-turn)', () => {
    const r = evaluateQuietWindow(
      {key: 'm1:500', since: 1_000},
      20_000,
      'm2:900',
      QUIET,
    );
    expect(r.fire).toBe(false);
    expect(r.next).toEqual({key: 'm2:900', since: 20_000});
  });
});

describe('FX-J synthetic idle wakes the loop without any host event delivery', () => {
  test('v1-poll event drives a continuation for an active goal', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.liveSessions.add('session-1');
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-0',
    });

    expect(api.promptsSent.length).toBe(1);
    expect(machine.snapshot().turnCount).toBe(2);
  });

  test('the sweep skips a session the host never spoke for', async () => {
    // The un-kicked resumption: startup hydrates every persisted session, so
    // the poller's sweep must not synthesize idles for a session with no
    // host event in this process lifetime. Drive the SWEEP's own gate (not
    // a hand-delivered poll id, which bypasses the sweep and is served).
    // NOTE: the sweep is reached through the poller the hook factory starts
    // (idlePollerIntervalMs/idleQuietMs/idleGraceMs overridable); the stale
    // session's recovery flag must survive the sweep un-armed.
    const paused = makeActiveGoal();
    paused.status = 'paused';
    paused.stopReason = 'recovery';
    const machine = new GoalStateMachine(paused, {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.sessionGoals.set('session-1', [machine]);
    deps.runtime!.recoveryPendingSessions.add('session-1');
    const hooks = createHooks({
      ...deps,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await new Promise(r => setTimeout(r, 250));
      expect(api.promptsSent.length).toBe(0);
      expect(deps.runtime!.recoveryPendingSessions.has('session-1')).toBe(true);
      expect(machine.snapshot().status).toBe('paused');
    } finally {
      await hooks.dispose?.();
    }
  });

  test('the sweep serves a session once the host speaks for it', async () => {
    // A session the user opens delivers chat.params (or a command dispatch)
    // first, which marks it live — the sweep then synthesizes idles for it.
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.sessionGoals.set('session-1', [machine]);
    const hooks = createHooks({
      ...deps,
      idlePollerIntervalMs: 20,
      idleQuietMs: 30,
      idleGraceMs: 0,
    });
    try {
      await hooks['chat.params']!({sessionID: 'session-1'} as never);
      await waitFor(
        () => api.promptsSent.length > 0,
        'the sweep to synthesize an idle for the live session',
      );
      expect(api.promptsSent.length).toBeGreaterThan(0);
    } finally {
      await hooks.dispose?.();
    }
  });

  test('repeated v1-poll ids do not double-send (claim dedupe holds)', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const deps = makeDeps(makeSessionContext(machine), api);
    deps.runtime!.liveSessions.add('session-1');
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-0',
    });
    // Same assistant turn still newest: the durable claim must suppress a
    // second send even though the poller fires again after its re-arm delay.
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-1',
    });

    expect(api.promptsSent.length).toBe(1);
  });

  test('synthetic poll DOES re-arm a recovery-paused goal (v1 delivers no authentic idles)', async () => {
    // REVERSED 2026-09-24 on evidence. This test previously asserted that a
    // synthetic poll could NOT re-arm a recovery-paused goal, on the rationale
    // that the host's authentic idle is the session-resume boundary. That
    // rationale deadlocks the host the poller exists for: stock v1 delivers NO
    // authentic idle events, so a goal that was ACTIVE at shutdown hydrated to
    // paused/recovery and then stayed there forever — the re-arm waited for an
    // idle that never came, and the poller's runnable filter skipped
    // recovery-paused goals so it never synthesized one either. Reproduced
    // (synthetic poll -> paused/recovery; authentic idle -> active). Reported
    // symptom: "resume doesn't reliably resume".
    //
    // The real guard is that `recoveryPendingSessions` is ONE-SHOT — it is
    // deleted the moment the re-arm runs — so accepting a synthetic idle cannot
    // loop, and an explicit/user/brake pause is still never re-armed.
    // Liveness: the re-arm fires for a session the host owns in this process,
    // so the fixture marks it live the way a chat.params dispatch would. A
    // session the host never spoke for is covered by the stale-session test
    // above, which asserts the flag is consumed without re-arming.
    const recovery = makeActiveGoal();
    recovery.goalId = 'recovery-goal';
    recovery.status = 'paused';
    recovery.stopReason = 'recovery';
    recovery.pausedAt = Date.now();
    const runnable = makeActiveGoal();
    runnable.goalId = 'runnable-goal';
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const recoveryMachine = new GoalStateMachine(recovery, {
      onCommit: async () => {},
    });
    const runnableMachine = new GoalStateMachine(runnable, {
      onCommit: async () => {},
    });
    const deps = makeDeps(
      makeSessionContext(recoveryMachine, [runnableMachine]),
      api,
    );
    deps.runtime!.recoveryPendingSessions.add('session-1');
    deps.runtime!.liveSessions.add('session-1');
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-0',
    });

    expect(recoveryMachine.snapshot().status).toBe('active');
    expect(recoveryMachine.snapshot().stopReason).toBe('');
    // One-shot: the flag is consumed, so a later poll cannot re-arm anything.
    expect(deps.runtime!.recoveryPendingSessions.has('session-1')).toBe(false);
  });

  test('an explicit pause is NOT re-armed by a synthetic poll', async () => {
    // The reversal above must not widen the blast radius: only `recovery`
    // re-arms. A user-issued pause stays paused.
    const parked = makeActiveGoal();
    parked.goalId = 'parked-goal';
    parked.status = 'paused';
    parked.stopReason = 'explicit pause';
    const runnable = makeActiveGoal();
    runnable.goalId = 'runnable-goal';
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const parkedMachine = new GoalStateMachine(parked, {
      onCommit: async () => {},
    });
    const runnableMachine = new GoalStateMachine(runnable, {
      onCommit: async () => {},
    });
    const deps = makeDeps(
      makeSessionContext(parkedMachine, [runnableMachine]),
      api,
    );
    deps.runtime!.recoveryPendingSessions.add('session-1');
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-0',
    });

    expect(parkedMachine.snapshot().status).toBe('paused');
    expect(parkedMachine.snapshot().stopReason).toBe('explicit pause');
  });

  test('id-less authentic idle still resets poll grace window', async () => {
    const machine = new GoalStateMachine(makeActiveGoal(), {
      onCommit: async () => {},
    });
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const deps = makeDeps(makeSessionContext(machine), api);
    const hooks = createHooks(deps);

    await hooks.event!({type: 'session.idle', sessionID: 'session-1'});
    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'v1-poll-0',
    });

    expect(api.promptsSent.length).toBe(1);
  });

  test('authentic idle resumes recovery-paused goals after synthetic poll', async () => {
    const recovery = makeActiveGoal();
    recovery.goalId = 'recovery-goal';
    recovery.status = 'paused';
    recovery.stopReason = 'recovery';
    const runnable = makeActiveGoal();
    runnable.goalId = 'runnable-goal';
    const api = makeMockSessionApi(makeWrappedAssistantMessages());
    const recoveryMachine = new GoalStateMachine(recovery, {
      onCommit: async () => {},
    });
    const runnableMachine = new GoalStateMachine(runnable, {
      onCommit: async () => {},
    });
    const deps = makeDeps(
      makeSessionContext(recoveryMachine, [runnableMachine]),
      api,
    );
    deps.runtime!.recoveryPendingSessions.add('session-1');
    const hooks = createHooks(deps);

    await hooks.event!({
      type: 'session.idle',
      sessionID: 'session-1',
      id: 'host-idle-0',
    });

    expect(recoveryMachine.snapshot().status).toBe('active');
    expect(recoveryMachine.snapshot().stopReason).toBe('');
  });

  test('poller serializes overlapping ticks and stop() is idempotent', async () => {
    let inFlight = 0;
    let overlap = false;
    let ticks = 0;
    const poller = createIdlePoller(1, async () => {
      ticks += 1;
      if (inFlight > 0) overlap = true;
      inFlight += 1;
      // MODELLED WORK, not a wait-for-effect. A real tick awaits I/O, so it is
      // in flight when the 1 ms interval next fires; without any await the tick
      // finishes synchronously, `running` is already false on re-entry, and the
      // serialization guard is never exercised — the test would then assert
      // `overlap === false` vacuously. Nothing below waits on this duration.
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
    });
    poller.start();
    poller.start(); // idempotent: must not arm a second interval
    await waitFor(() => ticks >= 3, 'at least 3 serialized poller ticks');

    poller.stop();
    poller.stop(); // idempotent: must not throw

    // Show stop actually stops, rather than asserting silence after a guessed
    // sleep: a WITNESS poller at the same interval keeps ticking, so once it has
    // advanced the stopped poller's count must be frozen.
    let witnessTicks = 0;
    const witness = createIdlePoller(1, async () => {
      witnessTicks += 1;
    });
    witness.start();
    try {
      await waitFor(() => witnessTicks >= 5, 'the witness poller to advance');
    } finally {
      witness.stop();
    }

    expect(overlap).toBe(false);
    expect(ticks).toBeGreaterThan(0);
    expect(witnessTicks).toBeGreaterThanOrEqual(5);
  });
});

describe("defer counters are GC'd with their goal", () => {
  function makeManager(): {
    manager: SessionStateManager;
    runtime: ReturnType<typeof createRuntimeState>;
    dir: string;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fxj-pol1-'));
    const runtime = createRuntimeState();
    const manager = new SessionStateManager(
      runtime,
      async () => true,
      // A DIRECTORY now: the manager resolves each goal's own ledger from the
      // root and the goal's session id.
      dir,
      undefined,
      EMPTY_INVALIDATION,
      CAN_WRITE_ANY,
      undefined,
      undefined,
      undefined,
      undefined,
      DEFAULT_GOAL_OPTIONS,
      async () => {},
    );
    return {manager, runtime, dir};
  }

  test("removeGoal clears the goal's defer entry", async () => {
    const {manager, runtime, dir} = makeManager();
    try {
      const machine = manager.createGoal('s1', 'Objective one', {});
      const goalId = machine.snapshot().goalId;
      runtime.deferCounts.set(`s1:${goalId}`, 2);

      await manager.removeGoal('s1', goalId);

      expect(runtime.deferCounts.has(`s1:${goalId}`)).toBe(false);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('clearSession wipes every defer entry for the session', async () => {
    const {manager, runtime, dir} = makeManager();
    try {
      runtime.deferCounts.set('s2:gA', 1);
      runtime.deferCounts.set('s2:gB', 3);
      runtime.deferCounts.set('s9:gZ', 5);

      // clearSession is async (serialized behind the session lifecycle lock);
      // the defer GC runs inside it, so the assertions must await it.
      await manager.clearSession('s2');

      expect(runtime.deferCounts.has('s2:gA')).toBe(false);
      expect(runtime.deferCounts.has('s2:gB')).toBe(false);
      expect(runtime.deferCounts.has('s9:gZ')).toBe(true);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('sub-second watchdog timeouts render honestly', () => {
  test('timeout below one second says <1s, never 0s', () => {
    const msg = watchdogTimeoutMessage('v2', 'pause goal', 400);
    expect(msg).toContain('<1s');
    expect(msg).not.toContain('within 0s');
  });
});
