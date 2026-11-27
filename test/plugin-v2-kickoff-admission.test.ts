import {expect, test} from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  MAX_UNCONFIRMED_KICKOFF_INPUTS,
  createV2KickoffInputID,
} from '../src/plugin-v2-kickoff-admission.ts';
import {
  attachment,
  deferred,
  createNativeKickoffFixture as fixture,
} from './fixtures/native-kickoff-host.ts';

test('native kickoff IDs use the host timestamp/counter layout and message ID length', () => {
  const now = 1800000000000;
  const first = createV2KickoffInputID(now);
  const second = createV2KickoffInputID(now);
  expect(first).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  expect(first.slice(4, 16)).toBe(
    ((BigInt(now) * 0x1000n + 1n) & 0xffffffffffffn)
      .toString(16)
      .padStart(12, '0'),
  );
  expect(second > first).toBe(true);
});

test('kickoff ID entropy characters stay uniformly distributed', () => {
  // CodeQL js/biased-cryptographic-random regression: reducing a random byte
  // modulo the 62-symbol alphabet biases symbols '0'-'7' (five source byte
  // values each) roughly +25% above the rest (four each). Rejection sampling
  // via randomInt must keep every symbol at the same expected frequency.
  const samples = 62_000;
  const counts = new Map<string, number>();
  for (let index = 0; index < samples; index++)
    for (const character of createV2KickoffInputID().slice(16))
      counts.set(character, (counts.get(character) ?? 0) + 1);
  const total = samples * 14;
  const expected = total / 62;
  // Uniform fluctuation is ~sqrt(expected) ≈ 120; the biased reduction would
  // push '0'-'7' about +3.5k from expected. 6% bounds noise at ~6σ while
  // still catching the regression several times over.
  const tolerance = expected * 0.06;
  expect(counts.size).toBe(62);
  for (const count of counts.values())
    expect(Math.abs(count - expected)).toBeLessThan(tolerance);
});

test('another current-cycle input before a late cancelled kickoff still runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-current-cycle-'));
  const f = await fixture(directory);
  const entered = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  try {
    f.history.set('s', [
      {id: 'msg_old_user', type: 'user', text: 'Previous request'},
      {
        id: 'msg_previous_assistant',
        type: 'assistant',
        text: 'Previous answer',
      },
    ]);
    f.afterPromptHook = async () => {
      entered.resolve();
      await release.promise;
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'inspect requirements', files: [attachment]},
      }),
    );
    await entered.promise;
    f.history.get('s')!.push({
      id: 'msg_fresh_other_input',
      type: 'user',
      text: 'Independent current request',
    });
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    release.resolve();
    await expect(command).rejects.toThrow(
      'Goal changed before kickoff admission completed.',
    );
    expect(
      (await f.context('s')).map(message => (message as {id: string}).id),
    ).toEqual([
      'msg_old_user',
      'msg_previous_assistant',
      'msg_fresh_other_input',
    ]);
    f.history.get('s')!.splice(2, 1);
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const stop of [false, true]) {
  test(`model context waits for the durable receipt${stop ? ' and rejects a stop during that wait' : ''}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-barrier-'));
    const f = await fixture(directory);
    const entered = deferred();
    const release = deferred();
    let command: Promise<unknown> | undefined;
    let model: Promise<{ok: boolean}> | undefined;
    let modelSettled = false;
    try {
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
            return {ok: true};
          },
          () => {
            modelSettled = true;
            return {ok: false};
          },
        );
      };
      command = Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'inspect requirements', files: [attachment]},
        }),
      );
      await entered.promise;
      await Promise.resolve();
      expect(modelSettled).toBe(false);
      if (stop)
        await f.hooks.runtime.executeSlashCommand!(
          {sessionID: 's', command: 'goal', arguments: 'pause'},
          {skipKickoff: true},
        );
      release.resolve();
      if (stop)
        await expect(command).rejects.toThrow(
          'Goal changed before kickoff admission completed.',
        );
      else await command;
      expect(await model).toEqual({ok: !stop});
    } finally {
      release.resolve();
      await command?.catch(() => {});
      await f.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

for (const method of ['prompt', 'synthetic'] as const) {
  test(`a stop during ${method} preparation cannot reach the model or compaction`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixate-host-preparation-'));
    const f = await fixture(directory);
    const entered = deferred();
    const release = deferred();
    let command: Promise<unknown> | undefined;
    try {
      f.afterPromptHook = async () => {
        entered.resolve();
        await release.promise;
      };
      command = Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {
            text: 'inspect requirements',
            ...(method === 'prompt' ? {files: [attachment]} : {}),
          },
        }),
      );
      await entered.promise;
      expect(f.snapshot('s').unconfirmedKickoffInputs).toHaveLength(1);
      await f.hooks['chat.message']!(
        {sessionID: 's'},
        {parts: [{type: 'text', text: 'stop'}]},
      );
      release.resolve();
      await expect(command).rejects.toThrow(
        'Goal changed before kickoff admission completed.',
      );
      expect(f.history.get('s')).toHaveLength(1); // The host may retain an inert receipt.
      await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
      await expect(f.context('s', 'compaction')).rejects.toThrow(
        'Goal history cannot be compacted or replayed',
      );
      const generated = await f.context('s', 'generate', [
        {
          role: 'user',
          content: [{type: 'text', text: 'Generate a new answer'}],
        },
      ]);
      expect(generated).toHaveLength(1);
      expect(JSON.stringify(generated)).not.toContain('inspect requirements');
      expect(
        (await f.title('s', 'opaque original: inspect requirements')).result,
      ).toBe('Goal');
      f.history.get('s')!.push({
        id: 'msg_user_later',
        type: 'user',
        text: 'Explain the paused state',
      });
      const messages = await f.context('s');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({id: 'msg_user_later'});
      const title = await f.title('s', 'opaque original: inspect requirements');
      expect(title.result).toBeUndefined();
      expect(JSON.stringify(title.messages)).toContain(
        'Explain the paused state',
      );
      expect(JSON.stringify(title.messages)).not.toContain(
        'inspect requirements',
      );
      // Unlike the title input, latest raw context no longer contains the first
      // user after compaction. Rebuilding must still drop that opaque original.
      f.history.set('s', [f.history.get('s')![1]]);
      const compactedTitle = await f.title(
        's',
        'opaque original: inspect requirements',
      );
      expect(compactedTitle.result).toBeUndefined();
      expect(JSON.stringify(compactedTitle.messages)).not.toContain(
        'inspect requirements',
      );
      f.history.set('other', [
        {id: 'msg_other', type: 'user', text: 'Unrelated task'},
      ]);
      expect(await f.context('other')).toHaveLength(1);
    } finally {
      release.resolve();
      await command?.catch(() => {});
      await f.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('the prompt hook rejects a stopped kickoff after host activation but before attachment preparation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-host-activation-'));
  const f = await fixture(directory);
  const entered = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  try {
    f.beforePromptHook = async () => {
      entered.resolve();
      await release.promise;
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'inspect requirements', files: [attachment]},
      }),
    );
    await entered.promise;
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    release.resolve();
    await expect(command).rejects.toThrow(
      'Goal changed before the host prepared its kickoff.',
    );
    expect(f.history.get('s')).toBeUndefined();
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('unconfirmed input guards survive clear, restart and forked message IDs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-host-restart-'));
  let f = await fixture(directory);
  const entered = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  try {
    f.afterPromptHook = async () => {
      entered.resolve();
      await release.promise;
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'inspect requirements', files: [attachment]},
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
    expect(f.snapshot('s').unconfirmedKickoffInputs).toHaveLength(1);
    const history = f.history;
    history.set('fork', [{...history.get('s')![0], id: 'msg_fork_fresh_id'}]);
    await f.dispose();
    f = await fixture(directory, history);
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
    await expect(f.context('fork')).rejects.toThrow('Cancelled goal kickoff');
    history
      .get('fork')!
      .push({id: 'msg_fork_user', type: 'user', text: 'A new task'});
    expect(await f.context('fork')).toEqual([
      {
        id: 'msg_fork_user',
        role: 'user',
        content: [{type: 'text', text: 'A new task'}],
      },
    ]);
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('confirmed kickoff history remains usable after clear, restart and fork', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-confirmed-history-'));
  let f = await fixture(directory);
  try {
    await f.execute({
      sessionID: 's',
      prompt: {text: 'inspect requirements', files: [attachment]},
    });
    expect(f.snapshot('s').unconfirmedKickoffInputs).toEqual([]);
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'clear'},
      {skipKickoff: true},
    );
    const history = f.history;
    history.set('fork', [{...history.get('s')![0], id: 'msg_fork_confirmed'}]);
    await f.dispose();
    f = await fixture(directory, history);
    expect(await f.context('s')).toHaveLength(1);
    expect(await f.context('fork')).toHaveLength(1);
    const title = await f.title('s', 'opaque host title prompt');
    expect(title.result).toBeUndefined();
    expect(JSON.stringify(title.messages)).toContain('inspect requirements');
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a cancellation at final checkpoint installation keeps the old durable denial', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-admission-commit-stop-'),
  );
  let f = await fixture(directory);
  let stopped: Promise<void> | undefined;
  try {
    const confirm = f.hooks.runtime.confirmKickoffInput!;
    f.hooks.runtime.confirmKickoffInput = (sid, confirmation) =>
      confirm(sid, {
        ...confirmation,
        assertActive: () => {
          const staged = readdirSync(
            join(directory, 'state', 'sessions', sid),
          ).some(name => name.startsWith('state.json.tmp-'));
          expect(staged).toBe(true);
          stopped = f.hooks['chat.message']!(
            {sessionID: sid},
            {parts: [{type: 'text', text: 'stop'}]},
          );
          confirmation.assertActive();
        },
      });
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'must stay cancelled', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('Goal changed before kickoff admission completed.');
    await stopped;
    expect(f.snapshot('s').unconfirmedKickoffInputs).toHaveLength(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
  } finally {
    await stopped;
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a failed atomic rename cannot acknowledge host acceptance', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-admission-rename-fault-'),
  );
  let f = await fixture(directory);
  try {
    const confirm = f.hooks.runtime.confirmKickoffInput!;
    f.hooks.runtime.confirmKickoffInput = (sid, confirmation) =>
      confirm(sid, {
        ...confirmation,
        assertActive: () => {
          confirmation.assertActive();
          const sessionDir = join(directory, 'state', 'sessions', sid);
          const staged = readdirSync(sessionDir).filter(name =>
            name.startsWith('state.json.tmp-'),
          );
          expect(staged).toHaveLength(1);
          rmSync(join(sessionDir, staged[0]));
        },
      });
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'unconfirmed after rename fault', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('will not be retried automatically');
    expect(f.snapshot('s').unconfirmedKickoffInputs).toHaveLength(1);
    expect(f.calls).toBe(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('accepted history stays confirmed when a later pause and cleanup fault occur', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-admission-commit-wins-'),
  );
  let f = await fixture(directory);
  const committed = deferred();
  const release = deferred();
  let command: Promise<unknown> | undefined;
  try {
    const confirm = f.hooks.runtime.confirmKickoffInput!;
    f.hooks.runtime.confirmKickoffInput = async (sid, confirmation) => {
      await confirm(sid, {
        ...confirmation,
        accepted: () => {
          confirmation.accepted();
          committed.resolve();
        },
      });
      await release.promise;
      throw new Error('post-commit cleanup failed');
    };
    command = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'accepted before later pause', files: [attachment]},
      }),
    );
    await committed.promise;
    expect(f.snapshot('s').unconfirmedKickoffInputs).toEqual([]);
    await f.hooks.runtime.executeSlashCommand!(
      {sessionID: 's', command: 'goal', arguments: 'pause'},
      {skipKickoff: true},
    );
    f.hooks.runtime.persistKickoffInput = async () => {
      throw new Error('a compensating write must not be needed');
    };
    release.resolve();
    await command;
    expect(f.calls).toBe(1);
    expect(await f.context('s')).toHaveLength(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history);
    expect(await f.context('s')).toHaveLength(1);
  } finally {
    release.resolve();
    await command?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

for (const damage of [
  'invalid-json',
  'unsupported-version',
  'empty-input-id',
  'whitespace-input-id',
  'empty-session-id',
  'unsafe-session-id',
  'missing-snapshot',
  'erased-directory',
  'erased-after-compaction',
] as const) {
  test(`lost admission history stays denied after ${damage} and a new native command`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'fixate-admission-lost-history-'),
    );
    let f = await fixture(directory);
    const entered = deferred();
    const release = deferred();
    let command: Promise<unknown> | undefined;
    try {
      f.afterPromptHook = async () => {
        entered.resolve();
        await release.promise;
      };
      command = Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'cancelled original', files: [attachment]},
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
      const history = f.history;
      await f.dispose();
      const statePath = join(directory, 'state', 'sessions', 's', 'state.json');
      if (damage === 'invalid-json') writeFileSync(statePath, '{corrupted');
      if (damage === 'unsupported-version')
        writeFileSync(statePath, '{"version":999}');
      if (
        damage === 'empty-input-id' ||
        damage === 'whitespace-input-id' ||
        damage === 'empty-session-id' ||
        damage === 'unsafe-session-id'
      ) {
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state.unconfirmedKickoffInputs[0] = {
          sessionID:
            damage === 'empty-session-id'
              ? ''
              : damage === 'unsafe-session-id'
                ? '../s'
                : 's',
          inputID:
            damage === 'empty-input-id'
              ? ''
              : damage === 'whitespace-input-id'
                ? ' \t '
                : state.unconfirmedKickoffInputs[0].inputID,
        };
        writeFileSync(statePath, JSON.stringify(state));
      }
      if (damage === 'missing-snapshot') rmSync(statePath);
      if (damage === 'erased-directory' || damage === 'erased-after-compaction')
        rmSync(join(directory, 'state'), {recursive: true});
      if (damage === 'erased-after-compaction') {
        history.set(
          'fork',
          history.get('s')!.map(row => ({...row, id: `fork_${row.id}`})),
        );
        // A completed host compaction hides the source input from context(),
        // but an older fork still carries that input and its original metadata.
        history.set('s', [
          {
            id: 'compaction',
            type: 'compaction',
            status: 'completed',
            text: 'Safe summary',
          },
        ]);
      }
      const guardedSession =
        damage === 'erased-after-compaction' ? 'fork' : 's';
      f = await fixture(directory, history);
      await expect(f.context(guardedSession)).rejects.toThrow(
        'Cancelled goal kickoff',
      );
      await expect(
        Promise.resolve(
          f.execute({
            sessionID: 's',
            prompt: {text: 'genuinely new task', files: [attachment]},
          }),
        ),
      ).rejects.toThrow();
      expect(f.calls).toBe(0);
      expect(f.hooks.runtime.kickoffInputHistoryKnownSessions.has('s')).toBe(
        false,
      );
      await f.dispose();
      f = await fixture(directory, history);
      await expect(f.context(guardedSession)).rejects.toThrow(
        'Cancelled goal kickoff',
      );
    } finally {
      release.resolve();
      await command?.catch(() => {});
      await f.dispose();
      rmSync(directory, {recursive: true, force: true});
    }
  });
}

test('disabling persistence permits local admission but cannot certify old inputs after restart', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-admission-memory-only-'),
  );
  let f = await fixture(directory, undefined, {persistState: false});
  try {
    await f.execute({
      sessionID: 's',
      prompt: {text: 'local task', files: [attachment]},
    });
    expect(await f.context('s')).toHaveLength(1);
    const history = f.history;
    await f.dispose();
    f = await fixture(directory, history, {persistState: false});
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'new task', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('Previous kickoff admission history is unavailable');
    expect(f.calls).toBe(0);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('unsupported model hooks leave ordinary requests usable but refuse native admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-old-host-'));
  const f = await fixture(directory, undefined, {rejectHooks: ['generate']});
  try {
    f.history.set('s', [
      {id: 'msg_user', type: 'user', text: 'An ordinary request'},
    ]);
    expect(await f.context('s')).toHaveLength(1);
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'requires native admission', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('every hook required');
    expect(f.calls).toBe(0);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a host without raw history keeps ordinary input working and refuses native admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-no-history-'));
  const f = await fixture(directory, undefined, {omitHistory: true});
  try {
    f.history.set('s', [
      {id: 'msg_user', type: 'user', text: 'An ordinary request'},
    ]);
    expect(await f.context('s')).toHaveLength(1);
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'requires native admission', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('every hook required');
    expect(f.calls).toBe(0);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a cancellation error from older admission cannot charge or pause a newer goal', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), 'fixate-admission-stale-error-'),
  );
  const f = await fixture(directory, undefined, {maxPromptFailures: 1});
  const enteredA = deferred();
  const enteredB = deferred();
  const releaseA = deferred();
  const releaseB = deferred();
  let commandA: Promise<unknown> | undefined;
  let commandB: Promise<unknown> | undefined;
  try {
    let preparing = 0;
    f.afterPromptHook = async () => {
      if (++preparing === 1) {
        enteredA.resolve();
        await releaseA.promise;
      } else {
        enteredB.resolve();
        await releaseB.promise;
      }
    };
    commandA = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'older A', files: [attachment]},
      }),
    );
    await enteredA.promise;
    commandB = Promise.resolve(
      f.execute({
        sessionID: 's',
        prompt: {text: 'newer B', files: [attachment]},
      }),
    );
    await enteredB.promise;
    releaseA.resolve();
    await expect(commandA).rejects.toThrow(
      'Goal changed before kickoff admission completed.',
    );
    const machine = f.hooks.runtime.sessionGoals.get('s')![0];
    const before = machine.snapshot();
    const contextError = await f.context('s').then(
      () => null,
      error => error as Error,
    );
    expect(contextError).toBeInstanceOf(Error);
    // Exact v2.2.7 toSessionError keeps only type:'unknown' and Error.message.
    const error = {type: 'unknown', message: contextError!.message};
    await f.hooks.event!({
      type: 'session.execution.failed',
      properties: {sessionID: 's', error},
    } as never);
    expect(machine.snapshot().revision).toBe(before.revision);
    expect(machine.snapshot().promptFailures).toBe(0);
    expect(machine.snapshot().status).toBe('active');
    expect(f.hooks.runtime.isKickoffCancellationError!('other', error)).toBe(
      false,
    );
    expect(
      f.hooks.runtime.isKickoffCancellationError!('s', {
        ...error,
        type: 'provider.transport',
      }),
    ).toBe(false);
    releaseB.resolve();
    await commandB;
    await f.hooks.event!({
      type: 'session.execution.failed',
      properties: {
        sessionID: 's',
        error: {type: 'unknown', message: 'Real unrelated failure'},
      },
    } as never);
    expect(machine.snapshot().promptFailures).toBe(1);
    expect(machine.snapshot().status).toBe('paused');
  } finally {
    releaseA.resolve();
    releaseB.resolve();
    await commandA?.catch(() => {});
    await commandB?.catch(() => {});
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('an accepted input with a failed admission receipt is paused without automatic duplicate admission', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-receipt-'));
  const f = await fixture(directory);
  try {
    f.hooks.runtime.confirmKickoffInput = async () => false;
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'inspect requirements', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('will not be retried automatically');
    expect(f.calls).toBe(1);
    expect(f.hooks.runtime.pendingKickoffDispatch?.get('s')?.size ?? 0).toBe(0);
    expect(f.hooks.runtime.sessionGoals.get('s')![0].snapshot().status).toBe(
      'paused',
    );
    expect(
      f.hooks.runtime.hasKickoffTimer?.(
        's',
        f.hooks.runtime.sessionGoals.get('s')![0].snapshot().goalId,
      ),
    ).toBe(false);
    await expect(f.context('s')).rejects.toThrow('Cancelled goal kickoff');
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});

test('the unconfirmed-input cap refuses new admission without forgetting old guards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-admission-bound-'));
  const f = await fixture(directory);
  try {
    const ids = new Set(
      Array.from(
        {length: MAX_UNCONFIRMED_KICKOFF_INPUTS},
        (_, index) => `msg_old_${index}`,
      ),
    );
    f.hooks.runtime.unconfirmedKickoffInputs.set('s', ids);
    await expect(
      Promise.resolve(
        f.execute({
          sessionID: 's',
          prompt: {text: 'inspect requirements', files: [attachment]},
        }),
      ),
    ).rejects.toThrow('too many unconfirmed goal inputs');
    expect(f.calls).toBe(0);
    expect(ids.size).toBe(MAX_UNCONFIRMED_KICKOFF_INPUTS);
    expect(ids.has('msg_old_0')).toBe(true);
  } finally {
    await f.dispose();
    rmSync(directory, {recursive: true, force: true});
  }
});
