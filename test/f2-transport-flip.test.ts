// phase-2 transport-flip locks.
//
// Laws under test:
// 1. ZERO-PUBLISH: on a stock-v1-shaped host (client.tui.publish present),
// goal lifecycle commits and usage churn produce ZERO publish calls —
// that endpoint renders every envelope as a user-visible toast.
// 2. V2 UNAFFECTED: the invisible metadata transport (pluginOptions
//.tuiTransport) still receives every lifecycle event it did before.
// 3. DISK REFRESH LAW: the companion's polling loop baselines silently,
// then synthesizes create/transition/remove events from revision diffs.

import {describe, expect, test} from 'bun:test';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalsPlugin} from '../src/plugin.ts';
import type {GoalTuiEvent, GoalTuiSnapshot} from '../src/tui-state.ts';
import {createTuiStateStore} from '../src/tui-state.ts';
import {createDiskRefreshLoop} from '../src/tui-companion-refresh.ts';

/** The session whose state file these fixtures write; a companion reads every
 * session, so one is enough, and naming it keeps the layout visible here. */
const SESSION_ID = 's1';

const NO_PERSIST = {persistState: false};

function makeV1Client() {
  const publishCalls: unknown[] = [];
  const promptCalls: unknown[] = [];
  return {
    publishCalls,
    promptCalls,
    client: {
      app: {
        log: async () => {},
      },
      session: {
        messages: async () => ({data: []}),
        promptAsync: async (input: unknown) => {
          promptCalls.push(input);
          return {};
        },
      },
      // Stock-v1 shape: the host exposes the (toast-rendering) publish endpoint.
      tui: {
        publish: async (input: unknown) => {
          publishCalls.push(input);
          return {};
        },
      },
    },
  };
}

async function runGoalCommand(
  hooks: Awaited<ReturnType<typeof GoalsPlugin>>,
  sessionID: string,
  args: string,
): Promise<string> {
  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    output,
  );
  return output.parts[0]?.text ?? '';
}

describe('zero-publish law', () => {
  test('goal lifecycle commits emit NOTHING on stock-v1 client.tui.publish', async () => {
    const {client, publishCalls} = makeV1Client();
    const hooks = await GoalsPlugin({client}, NO_PERSIST);

    await runGoalCommand(hooks, 'ses-f2', 'write the quarterly report'); // create commit
    await runGoalCommand(hooks, 'ses-f2', 'pause'); // transition commit
    await runGoalCommand(hooks, 'ses-f2', 'resume'); // transition commit

    expect(publishCalls).toHaveLength(0);
  });

  test('the invisible v2 metadata transport still receives lifecycle events', async () => {
    const {client} = makeV1Client();
    const transportEvents: GoalTuiEvent[] = [];
    const hooks = await GoalsPlugin(
      {client},
      {
        ...NO_PERSIST,
        tuiTransport: (_sessionID: string, event: GoalTuiEvent) => {
          transportEvents.push(event);
          return Promise.resolve();
        },
      },
    );

    await runGoalCommand(hooks, 'ses-f2b', 'write the quarterly report');
    await runGoalCommand(hooks, 'ses-f2b', 'pause');

    const kinds = transportEvents.map(e => e.kind);
    expect(kinds).toContain('create');
    expect(kinds).toContain('transition');
  });
});

function snapshot(overrides: Partial<GoalTuiSnapshot> = {}): GoalTuiSnapshot {
  return {
    goalId: 'g1',
    sessionID: SESSION_ID,
    condition: 'objective',
    status: 'active',
    revision: 1,
    turnCount: 0,
    totalTokens: 0,
    maxTokens: 200000,
    maxTurns: 10,
    tokenBudget: null,
    usage: {},
    stopReason: '',
    blockedReason: '',
    createdAt: 0,
    updatedAt: 0,
    finishedAt: null,
    lastCheckpoint: null,
    history: [],
    ...overrides,
  } as GoalTuiSnapshot;
}

describe('disk-refresh loop', () => {
  test('silent baseline, then create/transition/remove synthesized from diffs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-'));
    try {
      const goalsDir = join(dir, '.opencode', 'goals', 'sessions', SESSION_ID);
      await mkdir(goalsDir, {recursive: true});
      const statePath = join(goalsDir, 'state.json');

      const events: GoalTuiEvent[] = [];
      const store = createTuiStateStore();
      const loop = createDiskRefreshLoop({
        directory: dir,
        store,
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      // State must exist BEFORE start: the immediate baseline tick reads
      // it asynchronously, and an empty baseline would synthesize a spurious
      // "create" for pre-existing goals (the silent-baseline law).
      await writeFile(statePath, JSON.stringify({goals: [snapshot()]}));
      // Seed the silent baseline and drive ticks EXPLICITLY. Starting the
      // interval would race the async file read: a fixed sleep is not a
      // synchronisation primitive.
      loop.seedBaseline([snapshot()]);
      await loop.tick();
      expect(events).toHaveLength(0);

      // New goal appears -> create.
      await writeFile(
        statePath,
        JSON.stringify({
          goals: [
            snapshot(),
            snapshot({goalId: 'g2', condition: 'second objective'}),
          ],
        }),
      );
      await loop.tick();
      expect(events.map(e => e.kind)).toEqual(['create']);
      expect(events[0]!.snapshot?.origin).toBe('disk');

      // Revision bumps -> transition.
      await writeFile(
        statePath,
        JSON.stringify({
          goals: [
            snapshot({revision: 7, status: 'complete'}),
            snapshot({goalId: 'g2', condition: 'second objective'}),
          ],
        }),
      );
      await loop.tick();
      expect(events.map(e => e.kind)).toEqual(['create', 'transition']);
      expect(events[1]!.snapshot?.status).toBe('complete');

      // Goals vanish -> remove events for BOTH.
      await writeFile(statePath, JSON.stringify({goals: []}));
      await loop.tick();
      expect(events.map(e => e.kind)).toEqual([
        'create',
        'transition',
        'remove',
        'remove',
      ]);
      expect(events.map(e => e.goalId).sort()).toEqual(['g1', 'g2']);

      // Store reflects final truth: a successfully-read empty file means cleared.
      expect(store.getAllSnapshots().map(s => s.goalId)).toEqual([]);

      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('usage-only rewrites with identical revisions emit nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-quiet-'));
    try {
      const goalsDir = join(dir, '.opencode', 'goals', 'sessions', SESSION_ID);
      await mkdir(goalsDir, {recursive: true});
      const statePath = join(goalsDir, 'state.json');

      const events: GoalTuiEvent[] = [];
      const loop = createDiskRefreshLoop({
        directory: dir,
        store: createTuiStateStore(),
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      // State must exist BEFORE start: the immediate baseline tick reads
      // it asynchronously (an empty baseline would fabricate events).
      await writeFile(statePath, JSON.stringify({goals: [snapshot()]}));
      loop.seedBaseline([snapshot()]);
      await loop.tick();
      for (let i = 0; i < 3; i++) {
        await writeFile(
          statePath,
          JSON.stringify({goals: [snapshot({updatedAt: Date.now()})]}),
        );
        await loop.tick();
      }
      expect(events).toHaveLength(0);
      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('state file DELETED after baseline emits no removes (missing-dir leg of the trust rule)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-del-'));
    try {
      const goalsDir = join(dir, '.opencode', 'goals', 'sessions', SESSION_ID);
      await mkdir(goalsDir, {recursive: true});
      const statePath = join(goalsDir, 'state.json');

      const events: GoalTuiEvent[] = [];
      const loop = createDiskRefreshLoop({
        directory: dir,
        store: createTuiStateStore(),
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      // State must exist BEFORE start: the immediate baseline tick reads
      // it asynchronously (an empty baseline would fabricate events).
      await writeFile(statePath, JSON.stringify({goals: [snapshot()]}));
      loop.seedBaseline([snapshot()]);
      await loop.tick();
      expect(events).toHaveLength(0);
      await rm(statePath); // whole file gone — unreadable, NOT a legal clear
      await loop.tick();
      expect(events).toHaveLength(0); // no fabricated removals
      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('malformed or missing state files never throw and never fabricate removes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-bad-'));
    try {
      const goalsDir = join(dir, '.opencode', 'goals', 'sessions', SESSION_ID);
      await mkdir(goalsDir, {recursive: true});
      const statePath = join(goalsDir, 'state.json');

      const events: GoalTuiEvent[] = [];
      const loop = createDiskRefreshLoop({
        directory: dir,
        store: createTuiStateStore(),
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      // State must exist BEFORE start: the immediate baseline tick reads
      // it asynchronously (an empty baseline would fabricate events).
      await writeFile(statePath, JSON.stringify({goals: [snapshot()]}));
      loop.seedBaseline([snapshot()]);
      await loop.tick();
      await writeFile(statePath, '{not valid json'); // transient torn write
      await loop.tick();
      // Torn read must NOT be misread as "all goals removed".
      expect(events).toHaveLength(0);
      await writeFile(
        statePath,
        JSON.stringify({goals: [snapshot({revision: 2})]}),
      );
      await loop.tick();
      expect(events.map(e => e.kind)).toEqual(['transition']);
      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('PER-FILE CONTINUITY: torn session does not fabricate removes while healthy session removes still fire', async () => {
    // The core: garbage written into ONE session's
    // state.json must not cause a false "Goal cleared" for that session,
    // while a REAL removal in another session must still be reported.
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-continuity-'));
    try {
      const sesA = 'ses_a_healthy';
      const sesB = 'ses_b_torn';
      const goalsDirA = join(dir, '.opencode', 'goals', 'sessions', sesA);
      const goalsDirB = join(dir, '.opencode', 'goals', 'sessions', sesB);
      await mkdir(goalsDirA, {recursive: true});
      await mkdir(goalsDirB, {recursive: true});
      const pathA = join(goalsDirA, 'state.json');
      const pathB = join(goalsDirB, 'state.json');

      const snapA = snapshot({
        goalId: 'gA',
        sessionID: sesA,
        condition: 'goal A',
      });
      const snapB = snapshot({
        goalId: 'gB',
        sessionID: sesB,
        condition: 'goal B',
      });

      await writeFile(pathA, JSON.stringify({goals: [snapA]}));
      await writeFile(pathB, JSON.stringify({goals: [snapB]}));

      const events: GoalTuiEvent[] = [];
      const store = createTuiStateStore();
      // Hydrate the store the way the companion does at boot: seedBaseline is
      // SILENT by design (it sets the diff baseline but never fires events), so
      // the goals must be applied here for "the dashboard never empties" to be
      // observable on the store.
      for (const snap of [snapA, snapB]) {
        store.applyEvent({
          kind: 'create',
          sessionID: snap.sessionID,
          goalId: snap.goalId,
          snapshot: {...snap, origin: 'disk'},
          timestamp: Date.now(),
        });
      }
      const loop = createDiskRefreshLoop({
        directory: dir,
        store,
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      loop.seedBaseline([snapA, snapB]);
      await loop.tick();
      expect(events).toHaveLength(0);

      // Torn B, healthy A removes its goal.
      await writeFile(pathB, '{torn garbage');
      await writeFile(pathA, JSON.stringify({goals: []}));
      await loop.tick();

      // B's goals must NOT be removed (file unreadable).
      // A's goal IS removed (file read, goals gone).
      expect(events.map(e => e.kind)).toEqual(['remove']);
      expect(events[0]!.goalId).toBe('gA');
      expect(events[0]!.sessionID).toBe(sesA);

      // Store still holds B's goal — dashboard never empties for B.
      const bSnap = store.getSnapshots(sesB);
      expect(bSnap.map(s => s.goalId)).toContain('gB');

      // B's file heals: the carried-forward baseline must suppress a false
      // "create" (a false "Goal started"). No event, and the store still has gB.
      await writeFile(pathB, JSON.stringify({goals: [snapB]}));
      await loop.tick();
      expect(events.map(e => e.kind)).toEqual(['remove']);
      expect(store.getSnapshots(sesB).map(s => s.goalId)).toContain('gB');
      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });

  test('FORGED REVISIONS GONE: token-only transition carries disk revision, store accepts same-revision', async () => {
    // The old code bumped revision+1 for same-revision token changes,
    // falsely believing the store rejected them. That pushed the store
    // ahead of the disk, and a real server-side transition arriving at
    // the disk's true revision would be discarded as stale.
    // The store's guard is `snapshot.revision < existing.revision` — same
    // revision is accepted. So no forge is needed.
    const dir = await mkdtemp(join(tmpdir(), 'f2-refresh-forge-'));
    try {
      const goalsDir = join(dir, '.opencode', 'goals', 'sessions', SESSION_ID);
      await mkdir(goalsDir, {recursive: true});
      const statePath = join(goalsDir, 'state.json');

      const events: GoalTuiEvent[] = [];
      const store = createTuiStateStore();
      const loop = createDiskRefreshLoop({
        directory: dir,
        store,
        intervalMs: 20,
        onEvent: e => events.push(e),
      });
      const base = snapshot({revision: 5, totalTokens: 100});
      await writeFile(statePath, JSON.stringify({goals: [base]}));
      loop.seedBaseline([base]);
      await loop.tick();
      expect(events).toHaveLength(0);

      // Token-only update at same revision.
      const churned = snapshot({revision: 5, totalTokens: 500});
      await writeFile(statePath, JSON.stringify({goals: [churned]}));
      await loop.tick();

      // MUST emit a transition (tokens changed).
      expect(events).toHaveLength(1);
      expect(events[0]!.kind).toBe('transition');
      // MUST carry the disk's revision (5), NOT disk+1.
      expect(events[0]!.snapshot!.revision).toBe(5);
      // Store MUST have accepted it (same-revision is valid).
      const stored = store.getSnapshots(SESSION_ID);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.totalTokens).toBe(500);
      expect(stored[0]!.revision).toBe(5); // equals disk, not forged ahead
      loop.stop();
    } finally {
      await rm(dir, {recursive: true, force: true});
    }
  });
});
