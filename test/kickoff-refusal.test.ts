// kickoff-refusal.test.ts — a REFUSAL HAS TWO OBLIGATIONS, and the second one has
// as many paths as the first.
//
// Refusing to WRITE a session's file is half of what a fence owes. The other half is
// to stop ACTING on it: a session whose every write is declined must not be prompted
// into turns whose work cannot be persisted, and must not be charged tokens against a
// goal whose state is unreachable from disk. `canDriveSession` is the predicate for
// that half, and it consults both `refusedSessions` (a lease another live process
// holds) and `unreadableSessions` (either read ceiling).
//
// THE EVENT HANDLER IS NOT THE ONLY PATH, and this file exists because that was found
// the hard way. `src/hooks.ts` carries the gate at the top of its event handler, and
// the two ceiling tests measured zero continuation prompts from that path — but
// `scheduleKickoff` in `src/plugin-runtime.ts` is a SEPARATE timer reached from the
// command hook and from the goal-command tool, and its body checked `disposed`,
// `promptInFlight`, machine existence and goal identity without ever consulting
// `canDriveSession`. On a fenced session it then sent a synthetic continuation 2500 ms
// later: one prompt, against a goal whose turn count and token total were both
// unreachable from disk.
//
// WHY THE EXISTING TESTS SAW NONE OF IT, and this is the part worth keeping: those
// tests wait 200 ms, while `kickoffDelayMs` defaults to 2500 ms. They observed zero
// prompts because they looked BEFORE THE TIMER COULD FIRE, not because the timer was
// gated. So this file waits out the REAL default and shows the deadline elapsed with
// a SENTINEL in another session — a fixed sleep only shows a timer had not fired yet,
// and `continuation-parity.test.ts` already records why that is unsound.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';
import {createGoalState} from '../src/state-machine.ts';

/** The shipped default. The point of this file is that 200 ms cannot see it. */
const KICKOFF_DEFAULT_MS = 2500;
/** Past the default, with margin for a loaded machine. */
const PAST_DEFAULT_MS = 4200;

const CEILING = 16 * 1024 * 1024;

/**
 * A host client that records prompts.
 *
 * The adapter invokes host methods with a SINGLE flat argument, `{sessionID,...}`,
 * so the recording is verbatim and the session is read off the payload rather than
 * taken as a second parameter. The push happens before anything else is touched: an
 * early probe of this scenario reported zero prompts on a fenced session, and the
 * cause was the mock itself throwing on the argument shape before the push landed. A
 * mock that drops the observation is indistinguishable from the behaviour it measures.
 */
function recordingClient(prompts: string[]) {
  const waiters: Array<{
    predicate: (s: string) => boolean;
    resolve: () => void;
  }> = [];
  const pump = (sessionID: string): void => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(sessionID)) waiters.splice(i, 1)[0].resolve();
    }
  };
  return {
    client: {
      app: {
        log: async () => {},
      },
      session: {
        messages: async () => ({data: [] as unknown[]}),
        // `sdkShape: "flat"` (pinned below) delivers `{sessionID,...payload}` as a
        // SINGLE argument. The default shape delivers `{path, body}` instead, with
        // the session at `path.id` — read at the wrong level this records
        // `"undefined"` for every prompt and every negative assertion then passes for
        // the wrong reason. Measured, not guessed: the first draft of this file made
        // exactly that mistake and the control arm is what exposed it.
        promptAsync: async (input: Record<string, unknown>) => {
          const sessionID = String(input['sessionID'] ?? '');
          prompts.push(sessionID);
          pump(sessionID);
          return {};
        },
        abort: async () => ({}),
      },
    },
    waitForPrompt: (
      predicate: (s: string) => boolean = () => true,
    ): Promise<void> => {
      const existing = prompts.find(predicate);
      if (existing !== undefined) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('no kickoff prompt within 6s')),
          6000,
        );
        waiters.push({
          predicate,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };
}

/**
 * A ledger past the ceiling, written as raw JSONL.
 *
 * Deliberately not through `appendWalEntry`: this fixture exists to make the READER
 * decline, and seeding through the product would advance the very counter the fence
 * is about. The removal tombstone is last, which is where a prefix would stop.
 */
async function writeOverCeilingLedger(ledgerPath: string): Promise<void> {
  await mkdir(join(ledgerPath, '..'), {recursive: true});
  const goal = createGoalState('ses-any', 'a goal the ledger knows about', {});
  goal.revision = 1;
  goal.status = 'paused';
  goal.stopReason = 'paused';
  const snapshot = JSON.stringify({...goal});
  const lines: string[] = [];
  let bytes = 0;
  let seq = 0;
  while (bytes < CEILING + 1024 * 1024) {
    const line = `${JSON.stringify({
      seq: ++seq,
      source: 'idle',
      from: 'paused',
      to: 'paused',
      detail: 'padding',
      snapshot,
      removed: false,
    })}\n`;
    lines.push(line);
    bytes += line.length;
  }
  lines.push(
    `${JSON.stringify({
      seq: ++seq,
      source: 'idle',
      from: 'paused',
      to: 'paused',
      detail: 'Goal removed',
      snapshot,
      removed: true,
    })}\n`,
  );
  await writeFile(ledgerPath, lines.join(''));
}

type Hooks = Awaited<ReturnType<typeof GoalsPlugin>>;

/** Drive a command for a session. A bare objective creates a goal and enters active. */
async function run(
  hooks: Hooks,
  sessionID: string,
  args: string,
): Promise<string> {
  const out: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    out,
  );
  return out.parts.map(p => p.text).join('\n');
}

describe('a REFUSED session is not prompted a continuation it can never persist', () => {
  test('the kickoff timer consults canDriveSession, past the DEFAULT delay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kickoff-refusal-'));
    const stateRoot = join(dir, 'goals');
    const prompts: string[] = [];
    const hooksList: Hooks[] = [];
    try {
      const {client, waitForPrompt} = recordingClient(prompts);
      // The workspace is EMPTY at load — the ordinary shape for a session that has not
      // run a goal — and the over-ceiling ledger arrives afterwards, which is the case
      // the startup fence cannot see.
      const hooks = await GoalsPlugin(
        {directory: dir, client: client as never},
        {
          stateRoot,
          sdkShape: 'flat' as const,
          idlePoller: false,
          registerAgents: false,
        },
      );
      hooksList.push(hooks);

      const fenced = 'ses-kick-fenced';
      const paths = join(stateRoot, 'sessions', fenced);
      await mkdir(paths, {recursive: true});
      const ledgerPath = `${paths}/state.json.ledger.jsonl`;
      await writeOverCeilingLedger(ledgerPath);
      expect(
        (await stat(ledgerPath)).size,
        'the fixture did not cross the ceiling',
      ).toBeGreaterThan(CEILING);

      // THE CONTROL, and it comes FIRST: an ordinary session in the same workspace is
      // prompted a kickoff. Without this arm, "no prompts" could mean the kickoff
      // never fires at all rather than that the gate holds — which is exactly the
      // ambiguity the 200 ms windows in the shipped ceiling tests could not resolve.
      const control = 'ses-kick-control';
      await run(hooks, control, 'a control goal with nothing wrong with it');
      await waitForPrompt(s => s === control);
      expect(
        prompts.filter(s => s === control).length,
        'the control session was never prompted, so a later absence would mean nothing',
      ).toBe(1);

      // Fence for real: creating a goal here writes the ledger, which consults the
      // fence, which declines and reports.
      const said = await run(hooks, fenced, 'a goal in a fenced session');
      expect(
        said,
        'the session was not fenced: the ceiling never reached the write path',
      ).toContain('NOT SAVED');

      // PAST THE DEFAULT DELAY, with the deadline witnessed by a sentinel in ANOTHER
      // session rather than by a guessed sleep. Resolving on the first prompt of any
      // kind would let the fenced session's own stray kickoff satisfy the wait and
      // make the negative assertion pass while the defect is firing.
      const sentinel = `${control}-sentinel`;
      await run(hooks, sentinel, 'sentinel deadline probe');
      await waitForPrompt(s => s === sentinel);
      await new Promise(r =>
        setTimeout(r, PAST_DEFAULT_MS - KICKOFF_DEFAULT_MS),
      );

      expect(
        prompts.filter(s => s === fenced),
        `a fenced session was prompted a continuation it can never persist (default delay ${KICKOFF_DEFAULT_MS}ms)`,
      ).toEqual([]);
      expect(
        prompts.filter(s => s === control).length,
        'the gate disabled kickoffs wholesale rather than for the fenced session alone',
      ).toBe(1);
    } finally {
      for (const hooks of hooksList) await hooks.dispose?.();
      await rm(dir, {recursive: true, force: true});
    }
  }, 120_000);
});
