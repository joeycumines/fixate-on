import {describe, expect, test} from 'bun:test';
import {createHooks} from '../src/hooks.ts';
import {mapV2EventToHandlers} from '../src/plugin-v2-event-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';
import {
  MAX_BACKGROUND_WAIT_MS,
  nextDeferralOnBlockedIdle,
  shouldSuppressTrailingIdle,
} from '../src/plugin-v2-helpers.ts';
import {GoalStateMachine} from '../src/state-machine.ts';
import type {HookDeps} from '../src/hooks-types.ts';
import {createIdleStateFixture, idleAssistant} from './idle-state-fixture.ts';

/** Capture the real poller callback; all fixture persistence completes in memory. */
function capturePoller(deps: HookDeps): () => Promise<void> {
  const original = globalThis.setInterval;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((callback: () => void) => {
    tick = callback;
    return {unref: () => {}};
  }) as typeof setInterval;
  try {
    createHooks({...deps, idlePoller: true});
  } finally {
    globalThis.setInterval = original;
  }
  if (!tick) throw new Error('The idle poller was not registered');
  const run = tick;
  return async () => {
    run();
    // A macrotask boundary drains the actual asynchronous tick and its in-memory
    // commits. There is no assumed elapsed duration or real polling timer.
    await new Promise<void>(resolve => setImmediate(resolve));
  };
}

describe('background deferrals survive control-only execution', () => {
  for (const start of ['session.execution.started', 'session.step.started']) {
    test(`${start} cannot let execution.succeeded bypass an outstanding deferral`, async () => {
      const f = createIdleStateFixture();
      const sid = f.session.sessionID;
      f.setMessages([
        idleAssistant('a1', 'Waiting for the running child.', 100),
      ]);
      const now = Date.now();
      const idleStateBySession = new Map([
        [sid, {turnSignature: 'id:a1', ts: now, backgroundBlocked: true}],
      ]);
      f.runtime.backgroundDeferrals!.set(sid, {
        jobKeys: ['subagent:child-1'],
        since: now,
        nextRecheckAt: now + 30_000,
        extensions: 0,
      });
      f.runtime.backgroundBlockedUntil.set(sid, now + 30_000);
      const deps = {
        ctx: {},
        hooks: Object.assign(f.hooks, {runtime: f.runtime}),
        idleStateBySession,
        lastObservedTurnBySession: new Map([[sid, 'id:a1']]),
        recentKickoffTexts: createRecentKickoffTextTracker(),
        locationDirectory: undefined,
        isStopped: () => false,
        stopSignal: new Promise<void>(() => {}),
      };
      await mapV2EventToHandlers({type: start, data: {sessionID: sid}}, deps);
      expect(idleStateBySession.has(sid)).toBe(false);
      expect(f.runtime.backgroundDeferrals!.has(sid)).toBe(true);
      expect(
        await mapV2EventToHandlers(
          {
            type: 'session.execution.succeeded',
            id: 'blocked',
            data: {sessionID: sid},
          },
          deps,
        ),
      ).toBe('suppressed');
      expect(f.prompts).toHaveLength(0);
      // An authoritative empty-background idle clears these two runtime records.
      f.runtime.backgroundDeferrals!.delete(sid);
      f.runtime.backgroundBlockedUntil.delete(sid);
      expect(
        await mapV2EventToHandlers(
          {
            type: 'session.execution.succeeded',
            id: 'cleared',
            data: {sessionID: sid},
          },
          deps,
        ),
      ).toBe('handled');
      expect(f.prompts).toHaveLength(1);
      expect(f.errors).toEqual([]);
    });
  }

  test('deferral checks are session-scoped even when no idle record exists', () => {
    const records = new Map();
    const deferred = (sid: string) => sid === 'blocked';
    expect(
      shouldSuppressTrailingIdle(records, 'blocked', '', 0, deferred),
    ).toBe(true);
    expect(
      shouldSuppressTrailingIdle(records, 'unblocked', '', 0, deferred),
    ).toBe(false);
    expect(shouldSuppressTrailingIdle(records, 'blocked', '', 0)).toBe(false);
  });
});

describe('background escalation has an absolute deadline', () => {
  test('overlapping reports preserve the clock and cannot extend its final recheck', () => {
    const since = 1_000_000;
    const original = nextDeferralOnBlockedIdle({
      jobKeys: ['child:1'],
      existing: undefined,
      now: since,
    });
    const nearBound = nextDeferralOnBlockedIdle({
      jobKeys: ['child:1', 'child:2'],
      existing: {...original, extensions: 4},
      now: since + MAX_BACKGROUND_WAIT_MS - 10_000,
    });
    expect(nearBound.since).toBe(since);
    expect(nearBound.extensions).toBe(4);
    expect(nearBound.nextRecheckAt).toBe(since + MAX_BACKGROUND_WAIT_MS);
    // A host that regenerates job keys must not restart the clock: only an
    // authoritative empty-background idle clears the deferral at all, so a
    // surviving record means the session has been blocked continuously.
    const newJobs = nextDeferralOnBlockedIdle({
      jobKeys: ['child:3'],
      existing: nearBound,
      now: nearBound.nextRecheckAt,
    });
    expect(newJobs.since).toBe(since);
    expect(newJobs.extensions).toBe(4);
    expect(newJobs.nextRecheckAt).toBe(since + MAX_BACKGROUND_WAIT_MS);
  });

  test('regenerated job keys every ten seconds still pause at fifteen minutes', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const f = createIdleStateFixture();
      const runTick = capturePoller(f.deps);
      const sid = f.session.sessionID;
      const start = now;
      for (let n = 0; n <= 96; n++) {
        now = start + n * 10_000;
        const deferral = nextDeferralOnBlockedIdle({
          jobKeys: [`subagent:child-${n}`],
          existing: f.runtime.backgroundDeferrals!.get(sid),
          now,
        });
        f.runtime.backgroundDeferrals!.set(sid, deferral);
        f.runtime.backgroundBlockedUntil.set(sid, deferral.nextRecheckAt);
        await runTick();
        if (f.machine.snapshot().status === 'paused') break;
      }
      expect(now - start).toBe(MAX_BACKGROUND_WAIT_MS);
      expect(f.machine.snapshot().stopReason).toBe(
        'background completion unreported',
      );
      expect(f.announcements).toHaveLength(1);
      expect(f.prompts).toHaveLength(0);
    } finally {
      Date.now = originalNow;
    }
  });

  test('same child reported every ten seconds still pauses at fifteen minutes', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const f = createIdleStateFixture();
      const runTick = capturePoller(f.deps);
      const sid = f.session.sessionID;
      const start = now;
      for (let n = 0; n <= 96; n++) {
        now = start + n * 10_000;
        const deferral = nextDeferralOnBlockedIdle({
          jobKeys: ['subagent:child-1'],
          existing: f.runtime.backgroundDeferrals!.get(sid),
          now,
        });
        f.runtime.backgroundDeferrals!.set(sid, deferral);
        f.runtime.backgroundBlockedUntil.set(sid, deferral.nextRecheckAt);
        await runTick();
        if (f.machine.snapshot().status === 'paused') break;
      }
      expect(now - start).toBe(MAX_BACKGROUND_WAIT_MS);
      expect(f.machine.snapshot().stopReason).toBe(
        'background completion unreported',
      );
      expect(f.announcements).toHaveLength(1);
      expect(f.prompts).toHaveLength(0);
      expect(f.runtime.backgroundDeferrals!.has(sid)).toBe(false);
      await runTick();
      expect(f.announcements).toHaveLength(1);
    } finally {
      Date.now = originalNow;
    }
  });

  test('a future recheck cannot hide expiry; fenced sessions remain untouched', async () => {
    const f = createIdleStateFixture();
    const sid = f.session.sessionID;
    const now = Date.now();
    f.runtime.backgroundDeferrals!.set(sid, {
      jobKeys: ['subagent:child-1'],
      since: now - MAX_BACKGROUND_WAIT_MS - 1,
      nextRecheckAt: now + 60_000,
      extensions: 1,
    });
    f.runtime.backgroundBlockedUntil.set(sid, now + 60_000);
    const runTick = capturePoller(f.deps);
    f.runtime.canDriveSession = () => false;
    await runTick();
    expect(f.machine.snapshot().status).toBe('active');
    expect(f.announcements).toHaveLength(0);
    expect(f.runtime.backgroundDeferrals!.has(sid)).toBe(true);
    f.runtime.canDriveSession = () => true;
    await runTick();
    expect(f.machine.snapshot().status).toBe('paused');
    expect(f.announcements).toHaveLength(1);
    expect(f.runtime.backgroundDeferrals!.has(sid)).toBe(false);
  });

  test('expiry pauses active and finalizing goals without changing existing pauses or blocks', async () => {
    const f = createIdleStateFixture();
    const finalizing = new GoalStateMachine({
      ...f.machine.snapshot(),
      goalId: 'finalizing',
      status: 'finalizing',
      finalizing: false,
    });
    const paused = new GoalStateMachine({
      ...f.machine.snapshot(),
      goalId: 'paused',
      status: 'paused',
      stopReason: 'explicit pause',
    });
    const blocked = new GoalStateMachine({
      ...f.machine.snapshot(),
      goalId: 'blocked',
      status: 'blocked',
      blockedReason: 'Awaiting input',
    });
    const all = [f.machine, finalizing, paused, blocked];
    f.session.listMachines = () => all;
    f.runtime.sessionGoals.set(f.session.sessionID, all);
    const now = Date.now();
    f.runtime.backgroundDeferrals!.set(f.session.sessionID, {
      jobKeys: ['subagent:child-1'],
      since: now - MAX_BACKGROUND_WAIT_MS - 1,
      nextRecheckAt: now - 1,
      extensions: 1,
    });
    await capturePoller(f.deps)();
    expect(f.machine.snapshot().status).toBe('paused');
    expect(finalizing.snapshot().status).toBe('paused');
    expect(paused.snapshot().stopReason).toBe('explicit pause');
    expect(blocked.snapshot().status).toBe('blocked');
    expect(blocked.snapshot().blockedReason).toBe('Awaiting input');
    expect(f.announcements).toHaveLength(1);
    expect(f.errors).toEqual([]);
  });
});
