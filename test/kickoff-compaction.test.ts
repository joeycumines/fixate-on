import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2KickoffInputID} from '../src/plugin-v2-kickoff-admission.ts';
import {SessionStateManager} from '../src/session-state-manager.ts';
import {
  attachment,
  createNativeKickoffFixture as fixture,
  deferred,
  type RawMessage,
} from './fixtures/native-kickoff-host.ts';

const checkpoint = (text = 'Admissible summary'): RawMessage => ({
  id: createV2KickoffInputID(),
  type: 'compaction',
  status: 'completed',
  text,
});

test('ordinary clean history is saved before compaction and remains usable after restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-ordinary-compaction-'));
  let f = await fixture(directory);
  try {
    f.history.set('s', [
      {id: 'ordinary-1', type: 'user', text: 'First ordinary task'},
      {id: 'answer-1', type: 'assistant', text: 'First answer'},
      {id: 'ordinary-2', type: 'user', text: 'Second ordinary task'},
    ]);
    expect(await f.context('s', 'compaction')).toHaveLength(3);
    expect(f.snapshot('s').kickoffInputHistoryKnown).toBe(true);
    expect(f.snapshot('s').unconfirmedKickoffInputs).toEqual([]);
    f.history.set('s', [checkpoint()]);
    expect(await f.context('s', 'generate')).toHaveLength(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    expect(await f.context('s')).toHaveLength(1);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a failed earlier history certification cannot undo a later successful checkpoint', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-history-certification-'),
  );
  let f = await fixture(directory);
  const entered = deferred();
  const release = deferred();
  const persist = SessionStateManager.prototype.persist;
  let first = true;
  let earlier: Promise<boolean> | undefined;
  try {
    SessionStateManager.prototype.persist = async function (sid, commit) {
      if (sid === 's' && first) {
        first = false;
        entered.resolve();
        await release.promise;
        return false;
      }
      return persist.call(this, sid, commit);
    };
    earlier = f.hooks.runtime.persistKickoffInputHistory!('s');
    await entered.promise;
    expect(await f.hooks.runtime.persistKickoffInputHistory!('s')).toBe(true);
    release.resolve();
    expect(await earlier).toBe(false);
    expect(f.hooks.runtime.kickoffInputHistoryKnownSessions.has('s')).toBe(
      true,
    );
    expect(f.snapshot('s').kickoffInputHistoryKnown).toBe(true);
    SessionStateManager.prototype.persist = persist;
    f.history.set('s', [checkpoint()]);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    expect(await f.context('s')).toHaveLength(1);
  } finally {
    release.resolve();
    await earlier?.catch(() => {});
    SessionStateManager.prototype.persist = persist;
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('confirmed compaction and its copied fork checkpoint preserve usable history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-confirmed-compaction-'));
  let f = await fixture(directory);
  try {
    await f.execute({
      sessionID: 's',
      prompt: {text: 'Accepted original', files: [attachment]},
    });
    expect(await f.context('s', 'compaction')).toHaveLength(1);
    const completed = checkpoint();
    f.history.set('s', [completed]);
    const copied = {...completed, id: `${createV2KickoffInputID()}_1`};
    f.history.set('fork', [copied]);
    f.forks.set('fork', 's');
    expect(await f.context('fork')).toHaveLength(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    f.forks.set('fork', 's');
    expect(await f.context('s')).toHaveLength(1);
    expect(await f.context('fork')).toHaveLength(1);
    await f.execute({
      sessionID: 'fork',
      prompt: {text: 'Work using the accepted checkpoint', files: [attachment]},
    });
    expect(await f.context('fork', 'compaction')).toHaveLength(2);
    expect(f.snapshot('fork').kickoffInputHistoryKnown).toBe(true);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const stop of [false, true]) {
  test(`native admission after a clean checkpoint waits for confirmation${stop ? ' and rejects a stop' : ''}`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'fixate-checkpoint-admission-'),
    );
    const f = await fixture(directory);
    const entered = deferred();
    const release = deferred();
    let command: Promise<unknown> | undefined;
    let model: Promise<boolean> | undefined;
    let modelSettled = false;
    try {
      f.history.set('s', [
        {id: 'ordinary', type: 'user', text: 'Earlier task'},
      ]);
      await f.context('s', 'compaction');
      f.history.set('s', [checkpoint()]);
      const confirm = f.hooks.runtime.confirmKickoffInput!;
      f.hooks.runtime.confirmKickoffInput = async (sid, confirmation) => {
        entered.resolve();
        await release.promise;
        return confirm(sid, confirmation);
      };
      f.onAdmitted = () => {
        model = f.context('s').then(
          () => {
            modelSettled = true;
            return true;
          },
          () => {
            modelSettled = true;
            return false;
          },
        );
      };
      command = Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'Use prior history', files: [attachment]},
        }),
      );
      await entered.promise;
      await Bun.sleep(10);
      expect(modelSettled).toBe(false);
      if (stop)
        await f.hooks.runtime.executeSlashCommand!(
          {sessionID: 's', command: 'goal', arguments: 'pause'},
          {skipKickoff: true},
        );
      release.resolve();
      if (stop)
        await expect(command).rejects.toThrow('Goal changed before kickoff');
      else await command;
      expect(await model).toBe(!stop);
    } finally {
      release.resolve();
      await command?.catch(() => {});
      await f.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('a late cancelled input prevents checkpoint replay after summary or cached-summary application', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-late-compaction-'));
  let f = await fixture(directory);
  const entered = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  try {
    f.history.set('s', [
      {id: 'ordinary', type: 'user', text: 'A prior accepted task'},
    ]);
    // The host may finish this model request, or apply a precomputed result,
    // after another input has arrived. The kept tail is reconstructed from raw
    // rows when the checkpoint is read, rather than from this hooked request.
    await f.context('s', 'compaction');
    f.afterPromptHook = async () => {
      entered.resolve();
      await release.promise;
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'Cancelled during summary', files: [attachment]},
      }),
    );
    await entered.promise;
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'clear'},
      {skipKickoff: true},
    );
    release.resolve();
    await expect(command).rejects.toThrow('Goal changed before kickoff');
    f.history.get('s')!.push({
      id: 'genuine-followup',
      type: 'user',
      text: 'This current input may still run before compaction',
    });
    expect(await f.context('s')).toHaveLength(2);
    const notices: string[] = [];
    f.hooks.runtime.announceKickoffFailure = async (_sid, text) => {
      notices.push(text);
    };
    await expect(f.context('s', 'compaction')).rejects.toThrow(
      'start a new session and resubmit',
    );
    const completed = checkpoint(
      '<summary>Safe prefix</summary><recent-context>Cancelled during summary</recent-context>',
    );
    f.history.set('s', [completed]);
    f.history.set('fork', [
      {...completed, id: `${createV2KickoffInputID()}_4`},
    ]);
    f.forks.set('fork', 's');
    for (const sid of ['s', 'fork']) {
      for (const kind of ['context', 'compaction', 'generate'] as const)
        await expect(f.context(sid, kind)).rejects.toThrow(
          'Goal history cannot be compacted or replayed',
        );
      expect((await f.title(sid, 'Opaque title with old text')).result).toBe(
        'Goal',
      );
    }
    expect(notices).toHaveLength(2); // one passive receipt per affected session
    expect(notices.every(text => !text.includes('[fixate-on:'))).toBe(true);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    f.forks.set('fork', 's');
    await expect(f.context('s')).rejects.toThrow('kickoff admission history');
    await expect(f.context('fork')).rejects.toThrow(
      'kickoff admission history',
    );
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('an existing unknown checkpoint cannot certify itself through compaction or new admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-unknown-checkpoint-'));
  const f = await fixture(directory);
  try {
    f.history.set('s', [checkpoint()]);
    for (const kind of ['context', 'compaction', 'generate'] as const)
      await expect(f.context('s', kind)).rejects.toThrow(
        'kickoff admission history is unresolved',
      );
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'New objective', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('kickoff admission history is unresolved');
    expect(f.calls).toBe(0);
    expect(f.hooks.runtime.kickoffInputHistoryKnownSessions.has('s')).toBe(
      false,
    );
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('an unknown copied-checkpoint ID cannot borrow its parent history', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-checkpoint-id-'));
  const f = await fixture(directory);
  try {
    f.history.set('s', [{id: 'user', type: 'user', text: 'Ordinary task'}]);
    await f.context('s', 'compaction');
    f.forks.set('fork', 's');
    f.history.set('fork', [{...checkpoint(), id: 'unsupported-fork-id'}]);
    await expect(f.context('fork')).rejects.toThrow(
      'kickoff admission history is unresolved',
    );
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});
