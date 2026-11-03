// rearm-provenance.test.ts — the ledger must say WHICH idle brought a goal back.
//
// `hooks.ts`'s idle handler serves two sources. The host delivers `session.idle`
// when a turn completes; the poller SYNTHESISES one when the host has delivered
// none, inferring a quiet turn from an absence of token deltas. Both took the same
// path and wrote the same record, so the ledger could not distinguish them.
//
// It matters for two reasons, and the first is the one that is easy to miss. On
// stock v1 the host delivers NO authentic idle at all (measured — the recovery
// re-arm waits for exactly that event), so every re-arm there is the poller's,
// while `/goal status` and the detail card tell the user their goal "re-arms
// automatically" as though a human turn were keeping the promise. Nothing in the
// durable record could answer that. The second is that a re-arm failure cannot be
// reproduced after the fact from a record that does not say which mechanism moved
// the goal.
//
// So `TransitionSource` gained `poll-idle`, and both re-arms take their source
// from the provenance rather than a constant. `source` is the machine token
// because a question asked of the ledger should not require parsing English;
// `detail` names the same fact in words because that is what a surface renders.

import {describe, expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';
import {readWalEntries, recoverState} from '../src/persistence-wal.ts';
import {sessionStatePaths} from '../src/session-paths.ts';
import {POLL_EVENT_PREFIX} from '../src/hooks.ts';

const HOST_SESSION = 'ses_prov_host';
const POLL_SESSION = 'ses_prov_poll';
const RECOVERY_SESSION = 'ses_prov_recovery';

/** One host, one goal, one idle — and the ledger the idle left behind. */
async function rearmFor(sessionID: string, idleId: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), 'rearm-'));
  try {
    const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
    try {
      await hooks['command.execute.before']!(
        {command: 'goal', sessionID, arguments: `objective for ${sessionID}`},
        {parts: []},
      );
      // A human message parks the goal at `user intervention`, which is the pause
      // the yield re-arm exists to undo — so the idle below has a real re-arm to
      // perform rather than nothing to record.
      // A real human message, which is what parks the goal at `user intervention`.
      // Empty arguments do NOT: the hook needs the parts to recognise text, so the
      // first version of this fixture never produced a yield at all and the
      // assertions below were reading the bookkeeping transitions instead.
      await hooks['chat.message']!(
        {sessionID} as never,
        {parts: [{type: 'text', text: 'let me say something'}]} as never,
      );
      await hooks.event!({
        type: 'session.idle',
        sessionID,
        id: idleId,
      } as never);
      const ledger = sessionStatePaths(
        join(root, '.opencode', 'goals'),
        sessionID,
      ).ledgerPath;
      return (await readWalEntries(ledger)).map(e => e.transition.source);
    } finally {
      await hooks.dispose?.();
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
}

/**
 * Restart over an existing workspace and fire one first idle; return the sources
 * the ledger then holds.
 *
 * A restart is what puts a goal into `recoveryPendingSessions`, and therefore what
 * makes the RECOVERY re-arm the one that runs — so the second test cannot be built
 * without it.
 */
async function rearmSourcesAfterRestart(
  workspace: string,
  sessionID: string,
  idleId: string,
): Promise<string[]> {
  // idlePoller false here: these cases assert on the RE-ARM's provenance,
  // not on the sweep, so no background sweep may fire mid-case. The sweep's
  // own liveness gate is covered in fxj-idle-poll.test.ts, which runs the
  // poller. A hand-delivered poll id stands in for the sweep's sanctioned
  // idle (the sweep marks liveness in the tick it fires). Marking the
  // session live must not itself consume the recovery flag, so it is done
  // through a status read — a read-only command that marks liveness without
  // moving goal state — rather than a second goal-creating dispatch.
  const hooks = await GoalsPlugin({directory: workspace}, {idlePoller: false});
  try {
    await hooks['command.execute.before']!(
      {command: 'goal', sessionID, arguments: 'status'},
      {parts: []},
    );
    await hooks.event!({type: 'session.idle', sessionID, id: idleId} as never);
    const ledger = sessionStatePaths(
      join(workspace, '.opencode', 'goals'),
      sessionID,
    ).ledgerPath;
    return (await readWalEntries(ledger)).map(e => e.transition.source);
  } finally {
    await hooks.dispose?.();
  }
}

describe('a re-arm records WHICH idle brought the goal back', () => {
  test("a host idle and the poller's synthetic idle write different sources", async () => {
    // Read from the LEDGER, not from an API, because the ledger is the thing under
    // suspicion: the whole defect is that the durable record could not tell them
    // apart, so asserting on an in-memory value would assert nothing.
    const fromHost = await rearmFor(HOST_SESSION, 'an-authentic-host-idle');
    const fromPoller = await rearmFor(POLL_SESSION, `${POLL_EVENT_PREFIX}7`);

    // EXACTLY THE RE-ARM, and both directions. Asserting on the whole source list
    // would be asserting on the park as well — the `user intervention` pause the
    // human message produces is itself an `idle-handler` transition, so "the poller
    // case does not contain idle-handler" is false for a reason that has nothing
    // to do with this change. The question is whether POLL-IDLE appears, and the
    // control for that is the host case, which must not.
    expect(
      fromHost,
      'the host-delivered idle recorded a poll-idle re-arm',
    ).not.toContain('poll-idle');
    expect(
      fromPoller,
      "the poller's idle recorded no poll-idle re-arm, so the distinction is not in the ledger",
    ).toContain('poll-idle');
    // And the other side of it is still recorded, so the new token did not
    // REPLACE the old one — which is the failure a rename would produce.
    expect(fromHost).toContain('idle-handler');
    expect(fromPoller).toContain('idle-handler');
  });

  test("the distinction is DURABLE, read back through the plugin's own reader", async () => {
    // "Durable" is the whole claim, so it is tested after the writing plugin is
    // gone and through `recoverState` rather than by re-reading the file the test
    // just wrote. An earlier version of this case asserted on `/goal history` and
    // was measuring how that surface renders rather than what is on disk — a
    // re-arm that recorded nothing would have satisfied it as long as SOME history
    // rendered.
    const root = await mkdtemp(join(tmpdir(), 'rearm-restart-'));
    try {
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        await hooks['command.execute.before']!(
          {command: 'goal', sessionID: POLL_SESSION, arguments: 'an objective'},
          {parts: []},
        );
        await hooks['chat.message']!(
          {sessionID: POLL_SESSION} as never,
          {parts: [{type: 'text', text: 'let me say something'}]} as never,
        );
        await hooks.event!({
          type: 'session.idle',
          sessionID: POLL_SESSION,
          id: `${POLL_EVENT_PREFIX}3`,
        } as never);
      } finally {
        await hooks.dispose?.();
      }

      // A fresh reader, from a cold process's point of view.
      const paths = sessionStatePaths(
        join(root, '.opencode', 'goals'),
        POLL_SESSION,
      );
      const entries = await readWalEntries(paths.ledgerPath);
      const rearm = entries.filter(e => e.transition.source === 'poll-idle');
      expect(
        rearm.length,
        'the poller-driven re-arm is not in the ledger after the writing plugin is gone',
      ).toBeGreaterThan(0);

      // And through the plugin's own recovery, which is what a restart actually
      // does — so the goal it restores is a goal the record can explain.
      // And through the plugin's own recovery, which is what a restart actually
      // does. The restored goal is ACTIVE — the re-arm took effect and the record
      // says a POLLER did it, which is the pair of facts a reader needs and could
      // not previously have together.
      const recovered = await recoverState(paths.statePath, paths.ledgerPath);
      expect(
        recovered.goals.map(g => g.status),
        'the re-armed goal did not come back running',
      ).toEqual(['active']);
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 60_000);

  test('the RECOVERY re-arm records it too, and a host idle there is the control', async () => {
    // The second re-arm site, and the one that made the first test insufficient: a
    // goal parked at `recovery` by a restart is re-armed by the SAME handler, and
    // its provenance was an untested constant. A mutation that left it at
    // `"idle-handler"` survived the whole file AND `session-resume.test.ts`, because
    // that test's idle is a host idle and the constant and the computed value
    // AGREE there — a control that cannot fail. So the discriminating case is a
    // restart whose FIRST idle is the poller's, which is exactly stock v1.
    const root = await mkdtemp(join(tmpdir(), 'rearm-recovery-'));
    try {
      const first = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        await first['command.execute.before']!(
          {
            command: 'goal',
            sessionID: RECOVERY_SESSION,
            arguments: 'a goal that was running',
          },
          {parts: []},
        );
      } finally {
        await first.dispose?.();
      }

      // CONTROL FIRST: a restart whose first idle is the HOST's records
      // `idle-handler`, so the next case is distinguished by the poll id alone.
      const byHost = await rearmSourcesAfterRestart(
        root,
        RECOVERY_SESSION,
        'a-host-idle',
      );
      expect(
        byHost,
        'the recovery re-arm recorded no provenance at all',
      ).toContain('idle-handler');
      expect(
        byHost,
        'a host-delivered idle recorded a poll-idle re-arm',
      ).not.toContain('poll-idle');

      // And the poller's.
      const byPoller = await rearmSourcesAfterRestart(
        root,
        RECOVERY_SESSION,
        `${POLL_EVENT_PREFIX}11`,
      );
      expect(
        byPoller,
        "the poller's first idle after a restart recorded no poll-idle re-arm",
      ).toContain('poll-idle');
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  }, 60_000);

  test('CONTROL: an idle that re-arms nothing records no provenance', async () => {
    // The control. A rule that stamped `poll-idle` on every idle would satisfy both
    // cases above while asserting nothing about re-arms, so this pins the negative:
    // an idle for a session with nothing paused writes no re-arm entry at all, and
    // the sources observed are exactly the ones the mechanism always wrote.
    const root = await mkdtemp(join(tmpdir(), 'rearm-control-'));
    try {
      const hooks = await GoalsPlugin({directory: root}, {idlePoller: false});
      try {
        await hooks.event!({
          type: 'session.idle',
          sessionID: 'ses_prov_nothing',
          id: `${POLL_EVENT_PREFIX}1`,
        } as never);
        const ledger = sessionStatePaths(
          join(root, '.opencode', 'goals'),
          'ses_prov_nothing',
        ).ledgerPath;
        expect(
          await readWalEntries(ledger),
          'an idle with nothing to re-arm wrote a ledger entry',
        ).toEqual([]);
      } finally {
        await hooks.dispose?.();
      }
    } finally {
      await rm(root, {recursive: true, force: true});
    }
  });
});
