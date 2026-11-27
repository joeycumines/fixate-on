import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  attachment,
  deferred,
  createNativeKickoffFixture,
} from './fixtures/native-kickoff-host.ts';

test('foreign context confirmed while the current input waits is retained', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-foreign-confirmation-'));
  const f = await createNativeKickoffFixture(directory);
  const confirming = deferred();
  const release = deferred();
  let parentPending = true;
  let model: Promise<unknown[]> | undefined;
  let command: Promise<unknown> | undefined;
  try {
    f.history.set('child', [
      {
        id: 'copied-parent-message',
        type: 'user',
        text: 'Required context admitted in the parent',
        metadata: {
          fixateOnKickoffInput: {
            sessionID: 'parent',
            inputID: 'parent-input',
          },
        },
      },
    ]);
    const owner = f.hooks.runtime.ownsKickoffInputHistory!;
    f.hooks.runtime.ownsKickoffInputHistory = sid =>
      sid === 'parent' ? false : owner(sid);
    f.hooks.runtime.readKickoffInputHistory = async sid => {
      if (sid !== 'parent') throw new Error('unexpected foreign session');
      return {
        known: true,
        unconfirmed: new Set(parentPending ? ['parent-input'] : []),
      };
    };
    const confirm = f.hooks.runtime.confirmKickoffInput!;
    f.hooks.runtime.confirmKickoffInput = async (sid, receipt) => {
      confirming.resolve();
      await release.promise;
      return confirm(sid, receipt);
    };
    f.onAdmitted = () => {
      model = f.context('child');
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 'child',
        prompt: {text: 'Continue the parent task', files: [attachment]},
      }),
    );
    await confirming.promise;
    await Bun.sleep(10);
    parentPending = false;
    release.resolve();
    await command;
    const request = await model!;
    expect(request).toHaveLength(2);
    expect(JSON.stringify(request)).toContain(
      'Required context admitted in the parent',
    );
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await model?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a foreign process refreshes admission history for the original session and a fork', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-foreign-'));
  const f = await createNativeKickoffFixture(directory);
  const entered = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  let reader: ReturnType<typeof Bun.spawn> | undefined;
  let readyResolve!: (value: unknown) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<unknown>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let resultResolve!: (value: {
    ids: string[];
    forkIds: string[];
    cachedUnconfirmed: string[];
  }) => void;
  let resultReject!: (error: Error) => void;
  const result = new Promise<{
    ids: string[];
    forkIds: string[];
    cachedUnconfirmed: string[];
  }>((resolve, reject) => {
    resultResolve = resolve;
    resultReject = reject;
  });
  // Observe either early failure even when the other phase is currently awaited.
  void ready.catch(() => {});
  void result.catch(() => {});
  try {
    await f.execute({
      sessionID: 's',
      prompt: {text: 'Earlier confirmed input', files: [attachment]},
    });
    const confirmedID = f.history.get('s')![0].id;
    reader = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'fixtures', 'kickoff-foreign-reader.ts'),
        directory,
      ],
      {
        stdout: 'ignore',
        stderr: 'pipe',
        ipc(message) {
          const event = message as {
            kind: string;
            known?: boolean;
            owner?: boolean;
            error?: string;
            ids: string[];
            forkIds: string[];
            cachedUnconfirmed: string[];
          };
          if (event.kind === 'ready') readyResolve(event);
          if (event.kind === 'result') resultResolve(event);
          if (event.kind === 'error') resultReject(new Error(event.error));
        },
      },
    );
    const errors = new Response(
      reader.stderr as ReadableStream<Uint8Array>,
    ).text();
    void reader.exited.then(async code => {
      if (code === 0) return;
      const error = new Error(`foreign reader exited ${code}: ${await errors}`);
      readyReject(error);
      resultReject(error);
    });
    expect(await ready).toEqual({kind: 'ready', known: true, owner: false});
    f.afterPromptHook = async () => {
      entered.resolve();
      await release.promise;
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'Later cancelled input', files: [attachment]},
      }),
    );
    await entered.promise;
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'clear'},
      {skipKickoff: true},
    );
    release.resolve();
    await expect(command).rejects.toThrow(
      'Goal changed before kickoff admission completed.',
    );
    reader.send({history: f.history.get('s')});
    const received = await result;
    expect(received.ids).toEqual([confirmedID]);
    expect(received.forkIds).toEqual(['msg_fork_0']);
    expect(received.cachedUnconfirmed).toEqual([]);
    expect(await reader.exited).toBe(0);
  } finally {
    release.resolve();
    await command?.catch(() => {});
    reader?.kill();
    await reader?.exited;
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
}, 10000);
