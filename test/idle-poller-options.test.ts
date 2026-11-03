// idle-poller-options.test.ts — the FX-J idle-poll fallback must be
// CONTROLLABLE from the plugin entry point, and must not fire mid-turn.
//
// Two defects this locks, both found by independent review:
// 1. `HookDeps.idlePoller` (and its interval/quiet/grace siblings) were
// declared and honoured in hooks.ts but NEVER forwarded from `PluginOptions`
// by plugin-runtime.ts. Every `GoalsPlugin(...)` instance therefore ran a 5 s
// timer that could not be switched off — measured, a plugin given NO host
// event fired 2 continuation prompts in 20 s purely from that timer, driving
// the continuation loop from a background interval inside the test process.
// 2. Now that the poller's newest-message selection is correct, its role check
// can pass on stock v1, where no authentic idle is ever delivered and so the
// grace window never applies. Only the quiet window governed, so a slow turn
// whose in-progress assistant message showed no token delta could draw a
// synthetic idle MID-TURN. The settled-turn gate refuses that.

import {describe, expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';

function recordingClient(messages: unknown[]): {
  client: unknown;
  prompts: unknown[];
} {
  const prompts: unknown[] = [];
  const client = {
    session: {
      messages: async () => messages,
      promptAsync: async (input: unknown) => {
        prompts.push(input);
        return {};
      },
      abort: async () => ({}),
      create: async () => ({id: 'child'}),
      prompt: async () => ({}),
      update: async () => ({}),
      get: async () => ({}),
      delete: async () => ({}),
    },
  };
  return {client, prompts};
}

/** A settled assistant turn, as both hosts stamp a finished turn. */
const SETTLED = {
  info: {
    id: 'msg_A',
    role: 'assistant',
    time: {created: 2000, completed: 2500},
    finish: 'stop',
  },
  parts: [{type: 'text', text: 'done'}],
};
const USER = {
  info: {id: 'msg_U', role: 'user', time: {created: 1000}},
  parts: [],
};
/** An assistant turn still streaming: no completed stamp, no finish. */
const STREAMING = {
  info: {id: 'msg_S', role: 'assistant', time: {created: 3000}},
  parts: [{type: 'text', text: 'thinking'}],
};

/**
 * Start a plugin against a fake host and drive a goal-adding command.
 *
 * The kickoff probe is a SEPARATE, pre-existing path that fires when the host
 * launches no agent turn for the command (as this fake host does), so it is
 * parked far in the future: every prompt counted here is the poller's own.
 * Counting raw prompts with the kickoff live would conflate the two, and
 * snapshotting a baseline after the fact cannot separate them either, because
 * the poller fires within tens of milliseconds and the goal then pauses on the
 * low-progress brake.
 *
 * `waitForPrompt` resolves the instant the poller's prompt lands, so a positive
 * test runs for exactly as long as the timer needs rather than a guessed sleep.
 * A NEGATIVE test ("the poller must not fire") cannot use a timeout to show
 * absence — it pairs this run with an ENABLED witness under identical options,
 * so the witness's prompt demonstrates the deadline passed with nothing to show
 * for it here.
 */
interface PollerRun {
  prompts: unknown[];
  waitForPrompt: () => Promise<void>;
  dispose: () => Promise<void>;
}

async function startPoller(
  options: Record<string, unknown>,
  messages: unknown[],
): Promise<PollerRun> {
  const dir = await mkdtemp(join(tmpdir(), 'goal-idlepoll-'));
  const {client, prompts} = recordingClient(messages);
  let signal!: () => void;
  const firstPrompt = new Promise<void>(resolve => {
    signal = resolve;
  });
  const wrapped = {
    session: {
      ...(client as {session: Record<string, unknown>}).session,
      promptAsync: async (input: unknown) => {
        prompts.push(input);
        signal();
        return {};
      },
    },
  };
  const hooks = (await GoalsPlugin(
    {client: wrapped as never, directory: dir} as never,
    {persistState: false, kickoffDelayMs: 600_000, ...options},
  )) as unknown as Record<string, unknown>;
  const handler = hooks['command.execute.before'] as
    | ((
        i: {sessionID: string; command: string; arguments: string},
        o: {parts: unknown[]},
      ) => Promise<void>)
    | undefined;
  await handler!(
    {
      sessionID: 'sess-poll',
      command: 'goal',
      arguments: 'add probe the poller',
    },
    {parts: [] as unknown[]},
  );

  return {
    prompts,
    waitForPrompt: async () => {
      if (prompts.length > 0) return;
      await Promise.race([
        firstPrompt,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(new Error('the idle poller produced no prompt within 2s')),
            2000,
          ),
        ),
      ]);
    },
    dispose: async () => {
      const d = hooks['dispose'] as (() => Promise<void>) | undefined;
      await d?.();
      await rm(dir, {recursive: true, force: true});
    },
  };
}

const AGGRESSIVE = {idlePollerIntervalMs: 20, idleQuietMs: 20};

describe('idle-poller options are reachable from the plugin entry point', () => {
  test('idlePoller: false stops the poller (no synthetic continuation without a host event)', async () => {
    // With the poller disabled and no host event dispatched, nothing may drive
    // the loop. Before the option was forwarded every GoalsPlugin instance ran
    // the timer regardless, so this was impossible to express at all.
    //
    // Absence needs a witness: an ENABLED run under the SAME options shows the
    // interval/quiet window is live and that the disabled run's silence is a
    // real difference in behaviour, not merely a wait that had not elapsed.
    const disabled = await startPoller({idlePoller: false, ...AGGRESSIVE}, [
      USER,
      SETTLED,
    ]);
    const witness = await startPoller({idlePoller: true, ...AGGRESSIVE}, [
      USER,
      SETTLED,
    ]);
    try {
      await witness.waitForPrompt();
      expect(witness.prompts.length).toBeGreaterThan(0);
      expect(disabled.prompts).toHaveLength(0);
    } finally {
      await disabled.dispose();
      await witness.dispose();
    }
  }, 15_000);

  test('the forwarded interval is honoured: an enabled poller DOES fire on a settled turn', async () => {
    // The positive control for the test above. A settled newest assistant turn
    // plus an aggressive interval/quiet window must synthesize an idle, showing
    // the option reaches HookDeps rather than being silently dropped.
    const run = await startPoller({idlePoller: true, ...AGGRESSIVE}, [
      USER,
      SETTLED,
    ]);
    try {
      await run.waitForPrompt();
      expect(run.prompts.length).toBeGreaterThan(0);
    } finally {
      await run.dispose();
    }
  }, 15_000);

  test('an in-progress (unsettled) newest turn draws NO synthetic idle', async () => {
    // The over-fire defect: on v1 no authentic idle arrives, so the grace window
    // never applies and only the quiet window governs. An assistant turn still
    // streaming must be refused rather than prompting into a live turn. The
    // witness shows the poller was armed and running the whole time.
    const streaming = await startPoller({idlePoller: true, ...AGGRESSIVE}, [
      USER,
      SETTLED,
      STREAMING,
    ]);
    const witness = await startPoller({idlePoller: true, ...AGGRESSIVE}, [
      USER,
      SETTLED,
    ]);
    try {
      await witness.waitForPrompt();
      expect(streaming.prompts).toHaveLength(0);
    } finally {
      await streaming.dispose();
      await witness.dispose();
    }
  }, 15_000);
});
