import {expect, test} from 'bun:test';
import {
  createGoalState,
  GoalStateMachine,
  type GoalState,
} from '../src/state-machine.ts';
import {
  acquirePromptInFlight,
  clearPromptInFlight,
  createRuntimeState,
  retainKickoffDispatch,
  removeKickoffDispatch,
  type PendingKickoffDispatch,
} from '../src/session-runtime.ts';
import {createKickoffWiring} from '../src/plugin-kickoff.ts';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import {registerV2GoalCommandBridge} from '../src/plugin-v2-command-bridge.ts';
import {createRecentKickoffTextTracker} from '../src/plugin-v2-command.ts';
import {
  canonicalGoalDispatch,
  classifyGoalCommandOperation,
  isBareGoalObjective,
  isReadOnlyGoalCommand,
} from '../src/commands-args.ts';
import type {CreateGoalOptions} from '../src/tools.ts';
import type {V2Context} from '../src/plugin-v2-helpers.ts';
import type {RuntimeState} from '../src/session-runtime.ts';

// Real command execution and state machines, with controlled storage/admission.
const sessionID = 'command-admission-test';
interface Dispatch {
  method: 'prompt' | 'synthetic';
  payload: Record<string, unknown>;
}
interface NativeInput {
  sessionID: string;
  prompt: {
    text: string;
    files?: unknown[];
    agents?: unknown[];
    skills?: unknown[];
  };
  delivery?: string;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}
async function drainUntil(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('operation did not reach the expected boundary');
}
async function drain() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}
function timers() {
  const savedSet = globalThis.setTimeout;
  const savedClear = globalThis.clearTimeout;
  let next = 1;
  const callbacks = new Map<number, () => void>();
  globalThis.setTimeout = ((callback: () => void, delay: number) => {
    if (delay !== 5000) throw new Error(`unexpected timer delay ${delay}`);
    const id = next++;
    callbacks.set(id, callback);
    return id;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    callbacks.delete(id);
  }) as typeof clearTimeout;
  return {
    callbacks,
    fire() {
      const entry = callbacks.entries().next().value;
      if (!entry) throw new Error('no pending timer');
      callbacks.delete(entry[0]);
      entry[1]();
    },
    restore() {
      globalThis.setTimeout = savedSet;
      globalThis.clearTimeout = savedClear;
    },
  };
}
async function harness() {
  const runtime = createRuntimeState();
  runtime.canDriveSession = () => true;
  const machines: GoalStateMachine[] = [];
  runtime.sessionGoals.set(sessionID, machines);
  let focused: GoalStateMachine | null = null;
  let created = 0;
  const removed: string[] = [];
  const replaced: string[] = [];
  const createdSnapshots: GoalState[] = [];
  const commits: Readonly<GoalState>[] = [];
  const persistedSnapshots: GoalState[][] = [];
  let persists = 0;
  const context = {
    sessionID,
    workspaceDirectory: '/tmp/command-admission-no-disk',
    getMachine: () => focused,
    getMachineById: (id: string) =>
      machines.find(m => m.snapshot().goalId === id) ?? null,
    listMachines: () => machines,
    listActiveGoals: () => machines.map(m => m.snapshot()),
    listArchivedResults: () => [],
    hasRetainedKickoff: (id: string) =>
      runtime.pendingKickoffDispatch?.get(sessionID)?.has(id) ?? false,
    kickoffAdmissionInFlight: (id: string) =>
      runtime.pendingKickoffDispatch?.get(sessionID)?.get(id)?.inFlight ??
      false,
    createGoal: (objective: string, options: CreateGoalOptions) => {
      const id = `goal-${++created}`;
      const m = new GoalStateMachine(
        createGoalState(sessionID, objective, {
          ...options,
          goalId: id,
          runId: `run-${created}`,
        }),
        {
          onCommit: async snapshot => {
            commits.push(snapshot);
          },
        },
      );
      createdSnapshots.push(m.snapshot());
      machines.push(m);
      focused = m;
      return m;
    },
    replaceGoals: async (objective: string, options: CreateGoalOptions) => {
      replaced.push(objective);
      machines.length = 0;
      return context.createGoal(objective, options);
    },
    removeGoal: async (id: string) => {
      removed.push(id);
      const index = machines.findIndex(m => m.snapshot().goalId === id);
      if (index >= 0) machines.splice(index, 1);
      if (focused?.snapshot().goalId === id) focused = machines[0] ?? null;
    },
    clearSession: () => {
      machines.length = 0;
      focused = null;
      runtime.pendingKickoffDispatch?.delete(sessionID);
      runtime.clearKickoffTimer?.(sessionID);
      clearPromptInFlight(runtime, sessionID);
    },
    focusGoal: async (id: string) => {
      focused = context.getMachineById(id);
      return {ok: true, machine: focused};
    },
    addOrderedSession: () => {},
    isOrdered: () => false,
    persist: async () => {
      persists++;
      persistedSnapshots.push(machines.map(m => m.snapshot()));
      return true;
    },
  };
  const prompts: Record<string, unknown>[] = [];
  const synthetics: Record<string, unknown>[] = [];
  const outputs: string[] = [];
  const announcements: string[] = [];
  let onPrompt: (
    input: Record<string, unknown>,
  ) => Promise<unknown> = async () => ({});
  let onSynthetic: (
    input: Record<string, unknown>,
  ) => Promise<unknown> = async () => ({});
  const session = {
    prompt: async (input: Record<string, unknown>) => {
      prompts.push(input);
      return onPrompt(input);
    },
    synthetic: async (input: Record<string, unknown>) => {
      synthetics.push(input);
      return onSynthetic(input);
    },
  };
  const wiring = createKickoffWiring({
    runtime,
    stateManager: {getMachine: () => focused} as never,
    sessionApi: {
      messages: async () => [],
      promptAsync: async () => {
        throw new Error('unexpected generic continuation');
      },
    } as never,
    getSessionContext: () => context as never,
    transitionReceipt: async () => ({receipt: '', changed: false}),
    commandName: 'goal',
    registerCommand: true,
    kickoffDelayMs: 5000,
  });
  runtime.executeSlashCommand = wiring.executeSlashCommand;
  runtime.scheduleKickoff = wiring.scheduleKickoff;
  runtime.clearKickoffTimer = wiring.clearKickoffTimer;
  runtime.getGoalStatus = (_sid, goalId) =>
    (goalId ? context.getMachineById(goalId) : focused)?.snapshot().status;
  runtime.retryPendingKickoffDispatch = async (_sid, value) => {
    const dispatch = value as Dispatch;
    await session[dispatch.method](dispatch.payload);
  };
  runtime.announceKickoffFailure = async (_sid, text) => {
    announcements.push(text);
  };
  let execute!: (input: NativeInput) => Promise<void>;
  const ctx = {
    session,
    command: {
      transform: async (
        cb: (draft: {add: (entry: {execute: typeof execute}) => void}) => void,
      ) => {
        cb({
          add: entry => {
            execute = entry.execute;
          },
        });
        return {dispose() {}};
      },
    },
  } as unknown as V2Context;
  await registerV2GoalCommandBridge({
    ctx,
    hooks: {runtime},
    pluginOptions: {},
    recentKickoffTexts: createRecentKickoffTextTracker(),
    disposers: [],
    publishOutput: async (_sid, text) => {
      outputs.push(text);
    },
  });
  return {
    runtime,
    context,
    machines,
    removed,
    replaced,
    createdSnapshots,
    commits,
    persistedSnapshots,
    prompts,
    synthetics,
    outputs,
    announcements,
    wiring,
    persisted: () => persists,
    pending: (id: string) =>
      runtime.pendingKickoffDispatch?.get(sessionID)?.get(id),
    setPrompt(fn: typeof onPrompt) {
      onPrompt = fn;
    },
    setSynthetic(fn: typeof onSynthetic) {
      onSynthetic = fn;
    },
    execute: (
      text: string,
      files?: unknown[],
      extra: Partial<NativeInput> = {},
    ) => execute({sessionID, prompt: {text, files}, ...extra}),
  };
}

for (const alias of ['clear', 'stop', 'off', 'reset', 'none', 'cancel']) {
  test(`${alias} newline objective uses the set path consistently, including attachments`, async () => {
    const h = await harness();
    const original = h.context.createGoal('existing objective', {});
    const id = original.snapshot().goalId;
    const line = `${alias}\n${id}`;
    expect(classifyGoalCommandOperation(line)).toBe('set');
    expect(isBareGoalObjective(line)).toBe(true);
    expect(canonicalGoalDispatch(line)).not.toBe(
      canonicalGoalDispatch(`${alias} ${id}`),
    );
    await h.execute(line, [{path: 'spec.md'}]);
    expect(h.replaced).toEqual([`${alias} ${id}`]);
    expect(h.removed).toEqual([]); // no clear operation ran before rejecting
    expect(h.machines).toHaveLength(1);
    expect(h.machines[0].snapshot().condition).toBe(`${alias} ${id}`);
    expect(h.prompts[0].files).toEqual([{path: 'spec.md'}]);
  });
}

test('horizontal clear with attachments rejects without any state mutation', async () => {
  const h = await harness();
  const id = h.context.createGoal('existing objective', {}).snapshot().goalId;
  await expect(h.execute(`clear\t${id}`, [{path: 'spec.md'}])).rejects.toThrow(
    /starting or resuming/,
  );
  expect(h.machines).toHaveLength(1);
  expect(h.removed).toEqual([]);
  expect(h.replaced).toEqual([]);
});

for (const line of [
  'history\n--full',
  'status\n--full',
  'list\nall',
  '--full',
]) {
  test(`${JSON.stringify(line)} reports state while retaining another admission`, async () => {
    const clock = timers();
    try {
      const h = await harness();
      h.setPrompt(async () => {
        throw new Error('unavailable');
      });
      await expect(
        h.execute('add attached objective', [{path: 'required.md'}]),
      ).rejects.toThrow('unavailable');
      const retained = h.pending('goal-1');
      expect(isReadOnlyGoalCommand(line)).toBe(true);
      expect(classifyGoalCommandOperation(line)).toBe('other');
      expect(isBareGoalObjective(line)).toBe(false);
      await h.execute(line);
      expect(h.outputs).toHaveLength(1);
      expect(h.pending('goal-1')).toBe(retained);
      expect(clock.callbacks.size).toBe(1);
      expect(h.prompts).toHaveLength(1);
      expect(h.synthetics).toHaveLength(0);
    } finally {
      clock.restore();
    }
  });
}

for (const succeeds of [false, true]) {
  test(`older retry ${succeeds ? 'success' : 'failure'} preserves another goal's payload and fence`, async () => {
    const clock = timers();
    try {
      const h = await harness();
      const oldAttempt = deferred();
      let oldRetryEntered = false;
      let oldCalls = 0;
      h.setPrompt(async input => {
        const file = (input.files as {path: string}[])[0].path;
        if (file === 'old.md' && ++oldCalls === 2) {
          oldRetryEntered = true;
          await oldAttempt.promise;
          if (succeeds) return {};
        }
        throw new Error('unavailable');
      });
      await expect(
        h.execute('add old objective', [{path: 'old.md'}]),
      ).rejects.toThrow('unavailable');
      clock.fire();
      await drainUntil(() => oldRetryEntered);
      await expect(
        h.execute('add new objective', [{path: 'new.md'}]),
      ).rejects.toThrow('unavailable');
      const newer = h.pending('goal-2');
      expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(true);
      expect((newer?.dispatch as Dispatch).payload.files).toEqual([
        {path: 'new.md'},
      ]);
      oldAttempt.resolve();
      await drain();
      expect(h.pending('goal-2')).toBe(newer);
      expect(h.pending('goal-1') === undefined).toBe(succeeds);
      expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(false);
      expect(clock.callbacks.size).toBe(succeeds ? 1 : 2);
    } finally {
      clock.restore();
    }
  });
}

test('older initial success cannot erase the newer failed admission', async () => {
  const clock = timers();
  try {
    const h = await harness();
    const olderAdmission = deferred();
    let entered = false;
    h.setPrompt(async input => {
      if ((input.files as {path: string}[])[0].path === 'old.md') {
        entered = true;
        await olderAdmission.promise;
        return {};
      }
      throw new Error('unavailable');
    });
    const older = h.execute('add old objective', [{path: 'old.md'}]);
    await drainUntil(() => entered);
    await expect(
      h.execute('add new objective', [{path: 'new.md'}]),
    ).rejects.toThrow('unavailable');
    const newer = h.pending('goal-2');
    expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(true);
    // A timer firing during the older admission must defer, not disappear.
    clock.fire();
    await drain();
    expect(clock.callbacks.size).toBe(1);
    expect(h.prompts).toHaveLength(2);
    olderAdmission.resolve();
    await older;
    expect(h.pending('goal-2')).toBe(newer);
    expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(false);
    h.setPrompt(async () => ({}));
    clock.fire();
    await drain();
    expect(h.prompts.at(-1)?.files).toEqual([{path: 'new.md'}]);
    expect(h.pending('goal-2')).toBeUndefined();
  } finally {
    clock.restore();
  }
});

test('exhaustion pauses, persists, announces and resumes the original complete dispatch', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    const files = [{path: 'required.md'}];
    const agents = [{name: 'required-agent'}];
    const skills = [{name: 'required-skill'}];
    await expect(
      h.execute('add attached objective', undefined, {
        prompt: {text: 'add attached objective', files, agents, skills},
        delivery: 'queue',
      }),
    ).rejects.toThrow('unavailable');
    const persistedBefore = h.persisted();
    for (let retry = 1; retry <= 3; retry++) {
      clock.fire();
      await drainUntil(() => h.prompts.length === retry + 1);
      await drainUntil(() => !h.runtime.promptInFlightSessions.has(sessionID));
    }
    await drainUntil(() => h.announcements.length === 1);
    expect(h.context.getMachine()?.snapshot().status).toBe('paused');
    expect(h.pending('goal-1')?.exhausted).toBe(true);
    expect(h.persisted()).toBeGreaterThan(persistedBefore);
    expect(h.announcements).toHaveLength(1);
    expect(h.announcements[0]).toContain('/goal resume goal-1');
    expect(clock.callbacks.size).toBe(0);
    h.setPrompt(async () => ({}));
    // Native SessionCommand fills an omitted delivery with "steer" before
    // invoking the plugin. That default must not rewrite the retained queue.
    await h.execute('resume', undefined, {delivery: 'steer'});
    expect(h.context.getMachine()?.snapshot().status).toBe('active');
    expect(h.prompts).toHaveLength(5);
    expect(h.prompts[4]).toMatchObject({
      files,
      agents,
      skills,
      delivery: 'queue',
    });
    expect(h.pending('goal-1')).toBeUndefined();
  } finally {
    clock.restore();
  }
});

test('goal-command resume re-arms an exhausted nonfocused dispatch with all inputs', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add attached objective', [{path: 'required.md'}]),
    ).rejects.toThrow('unavailable');
    for (let retry = 1; retry <= 3; retry++) {
      clock.fire();
      await drainUntil(() => h.prompts.length === retry + 1);
      await drain();
    }
    expect(h.pending('goal-1')?.exhausted).toBe(true);
    h.context.createGoal('other focused goal', {});
    h.setPrompt(async () => ({}));
    const resumed = await h.wiring.executeSlashCommand(
      {sessionID, command: 'goal', arguments: 'resume goal-1'},
      {skipReplayRecord: true, source: 'goal-command'},
    );
    expect(resumed.ok).toBe(true);
    expect(resumed.activatedGoal?.goalId).toBe('goal-1');
    expect(h.context.getMachine()?.snapshot().goalId).toBe('goal-2');
    expect(h.pending('goal-1')?.exhausted).toBe(false);
    expect(clock.callbacks.size).toBe(1);
    clock.fire();
    await drainUntil(() => h.pending('goal-1') === undefined);
    expect(h.prompts).toHaveLength(5);
    expect(h.prompts[4].files).toEqual([{path: 'required.md'}]);
    expect(h.context.getMachineById('goal-1')?.snapshot().status).toBe(
      'active',
    );
  } finally {
    clock.restore();
  }
});

for (const command of ['edit replacement objective', 'resume']) {
  test(`${command} refuses new attachments while the paused goal has an unresolved admission`, async () => {
    const h = await harness();
    const admission = deferred();
    let entered = false;
    h.setPrompt(async () => {
      entered = true;
      await admission.promise;
      return {};
    });
    const running = h.execute('add original objective', [
      {path: 'original.md'},
    ]);
    try {
      await drainUntil(() => entered);
      await h.execute('pause');
      await expect(h.execute(command, [{path: 'new.md'}])).rejects.toThrow(
        /still in flight/,
      );
      expect(h.context.getMachine()?.snapshot().status).toBe('paused');
      expect(h.context.getMachine()?.snapshot().condition).toBe(
        'original objective',
      );
      expect(h.prompts).toHaveLength(1);
      expect(h.pending('goal-1')?.inFlight).toBe(true);
    } finally {
      admission.resolve();
      await running;
    }
  });
}

test('resume refuses a persisted kickoff pause whose original payload was lost', async () => {
  const h = await harness();
  const machine = h.context.createGoal('objective with required inputs', {});
  await machine.transition('paused', {
    source: 'idle-handler',
    stopReason: 'kickoff admission failed',
    detail: 'restart fixture',
  });
  await expect(h.execute('resume')).rejects.toThrow('original kickoff inputs');
  expect(machine.snapshot().status).toBe('paused');
  expect(h.prompts).toHaveLength(0);
  await h.execute('resume', [{path: 'restored.md'}]);
  expect(machine.snapshot().status).toBe('active');
  expect(h.prompts[0].files).toEqual([{path: 'restored.md'}]);
});

test('failed and unrelated commands preserve retained work', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add attached objective', [{path: 'required.md'}]),
    ).rejects.toThrow('unavailable');
    const retained = h.pending('goal-1');
    await expect(h.execute('resume missing-goal')).rejects.toThrow(
      'No goal found',
    );
    await expect(h.execute('add')).rejects.toThrow('No objective');
    h.context.createGoal('other goal', {});
    await h.execute('pause goal-2');
    await h.execute('focus goal-2');
    expect(h.pending('goal-1')).toBe(retained);
    expect(clock.callbacks.size).toBe(1);
  } finally {
    clock.restore();
  }
});

test('clear during an admission prevents late failure from resurrecting it', async () => {
  const clock = timers();
  try {
    const h = await harness();
    const admission = deferred();
    let entered = false;
    h.setPrompt(async () => {
      entered = true;
      await admission.promise;
      throw new Error('late failure');
    });
    const running = h.execute('add objective', [{path: 'required.md'}]);
    const rejected = running.then(
      () => {
        throw new Error('expected rejection');
      },
      error => error as Error,
    );
    await drainUntil(() => entered);
    await h.execute('clear');
    admission.resolve();
    expect((await rejected).message).toBe('late failure');
    expect(h.runtime.pendingKickoffDispatch?.has(sessionID)).toBe(false);
    expect(clock.callbacks.size).toBe(0);
    expect(h.machines).toHaveLength(0);
  } finally {
    clock.restore();
  }
});

test('dispatch identity and prompt ownership survive replacement and clear', () => {
  const runtime = createRuntimeState();
  const older: PendingKickoffDispatch = {goalId: 'g', runId: 'r', dispatch: {}};
  const newer: PendingKickoffDispatch = {...older};
  retainKickoffDispatch(runtime, sessionID, older);
  retainKickoffDispatch(runtime, sessionID, newer);
  expect(removeKickoffDispatch(runtime, sessionID, older)).toBe(false);
  expect(runtime.pendingKickoffDispatch?.get(sessionID)?.get('g')).toBe(newer);
  const releaseOld = acquirePromptInFlight(runtime, sessionID);
  const releaseOther = acquirePromptInFlight(runtime, sessionID);
  releaseOther();
  expect(runtime.promptInFlightSessions.has(sessionID)).toBe(true);
  clearPromptInFlight(runtime, sessionID);
  const releaseNew = acquirePromptInFlight(runtime, sessionID);
  releaseOld();
  expect(runtime.promptInFlightSessions.has(sessionID)).toBe(true);
  releaseNew();
  expect(runtime.promptInFlightSessions.has(sessionID)).toBe(false);
});

test('attachment edit is checked against the actual resolved goal before mutation', async () => {
  const h = await harness();
  const goal = h.context.createGoal('original objective', {});
  // A preflight cache may be cold; execution must enforce the same restriction.
  h.runtime.getGoalStatus = () => undefined;
  await expect(
    h.execute('edit replacement', [{path: 'spec.md'}]),
  ).rejects.toThrow(/starting or resuming/);
  expect(goal.snapshot().condition).toBe('original objective');
  expect(h.prompts).toHaveLength(0);
});

test('an edit commit racing another admission retains its new attachments as a successor', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add original objective', [{path: 'original.md'}]),
    ).rejects.toThrow('unavailable');
    await h.execute('pause');
    const commit = deferred();
    let edited = false;
    const runner = h.runtime.executeSlashCommand!;
    h.runtime.executeSlashCommand = async (input, options) => {
      const result = await runner(input, options);
      if (input.arguments?.startsWith('edit ')) {
        edited = true;
        await commit.promise;
      }
      return result;
    };
    const editing = h.execute('edit replacement objective', [{path: 'new.md'}]);
    await drainUntil(() => edited);
    const admission = deferred();
    let entered = false;
    h.setPrompt(async () => {
      entered = true;
      await admission.promise;
      return {};
    });
    const resuming = h.execute('resume');
    await drainUntil(() => entered);
    const older = h.pending('goal-1');
    commit.resolve();
    await editing;
    const successor = h.pending('goal-1');
    expect(successor).not.toBe(older);
    expect((successor?.dispatch as Dispatch).payload.files).toEqual([
      {path: 'original.md'},
      {path: 'new.md'},
    ]);
    expect(clock.callbacks.size).toBe(1);
    admission.resolve();
    await resuming;
    expect(h.pending('goal-1')).toBe(successor);
    expect(h.context.getMachine()?.snapshot().kickoffAdmissionPending).toBe(
      true,
    );
    h.setPrompt(async () => ({}));
    clock.fire();
    await drainUntil(() => h.pending('goal-1') === undefined);
    expect(h.prompts.at(-1)?.files).toEqual([
      {path: 'original.md'},
      {path: 'new.md'},
    ]);
    expect(String(h.prompts.at(-1)?.text)).toContain('replacement objective');
    await drain();
    expect(h.context.getMachine()?.snapshot().kickoffAdmissionPending).toBe(
      false,
    );
  } finally {
    clock.restore();
  }
});

test('the registered goal-command tool resumes retained inputs when native commands are disabled', async () => {
  const hooks = await GoalsPlugin(
    {client: {session: {messages: async () => []}}},
    {
      persistState: false,
      idlePoller: false,
      registerCommand: false,
      kickoffDelayMs: 5000,
    },
  );
  const runtime = (hooks as typeof hooks & {runtime: RuntimeState}).runtime;
  const tool = hooks.tool!['goal-command'] as {
    execute: (
      input: {subcommand: string},
      context: {sessionID: string},
    ) => Promise<string>;
  };
  const clock = timers();
  try {
    await tool.execute({subcommand: 'add required inputs'}, {sessionID});
    runtime.clearKickoffTimer?.(sessionID);
    const machine = runtime.sessionGoals.get(sessionID)![0];
    const goal = machine.snapshot();
    await machine.transition('paused', {
      source: 'idle-handler',
      stopReason: 'kickoff admission failed',
      detail: 'exhausted retry fixture',
    });
    const payload = {
      sessionID,
      text: 'original',
      files: [{path: 'required.md'}],
    };
    retainKickoffDispatch(runtime, sessionID, {
      goalId: goal.goalId,
      runId: goal.runId,
      dispatch: {method: 'prompt', payload},
      exhausted: true,
      attempts: 3,
    });
    const calls: unknown[] = [];
    runtime.retryPendingKickoffDispatch = async (_sid, dispatch) => {
      calls.push(dispatch);
    };
    const result = await tool.execute(
      {subcommand: `resume ${goal.goalId}`},
      {sessionID},
    );
    expect(result).toContain('source=goal-command');
    expect(clock.callbacks.size).toBe(1);
    clock.fire();
    await drainUntil(() => calls.length === 1);
    expect((calls[0] as Dispatch).payload.files).toEqual([
      {path: 'required.md'},
    ]);
    await drainUntil(() => !runtime.pendingKickoffDispatch?.has(sessionID));
  } finally {
    await hooks.dispose?.();
    clock.restore();
  }
});

for (const command of [
  'new objective',
  'add new objective',
  'sequence first; second',
]) {
  test(`${command} marks required inputs in the first created state and before host admission`, async () => {
    const h = await harness();
    h.setPrompt(async () => {
      expect(h.createdSnapshots[0].kickoffAdmissionPending).toBe(true);
      const writes = h.persistedSnapshots
        .flat()
        .filter(g => g.goalId === 'goal-1');
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every(g => g.kickoffAdmissionPending)).toBe(true);
      expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(true);
      return {};
    });
    await h.execute(command, [{path: 'required.md'}]);
    expect(
      h.context.getMachineById('goal-1')?.snapshot().kickoffAdmissionPending,
    ).toBe(false);
    expect(h.pending('goal-1')).toBeUndefined();
  });
}

for (const command of ['resume', 'edit replacement objective']) {
  test(`${command} marks required inputs before its first durable active transition`, async () => {
    const h = await harness();
    const goal = h.context.createGoal('original objective', {});
    await goal.transition('paused', {
      source: 'slash-command',
      stopReason: 'paused',
    });
    h.commits.length = 0;
    h.setPrompt(async () => {
      const activeCommits = h.commits.filter(g => g.status === 'active');
      expect(activeCommits.length).toBeGreaterThan(0);
      expect(activeCommits.every(g => g.kickoffAdmissionPending)).toBe(true);
      return {};
    });
    await h.execute(command, [{path: 'required.md'}]);
    expect(goal.snapshot().kickoffAdmissionPending).toBe(false);
  });
}

test('a restart before retry exhaustion requires original inputs even if the goal is still active', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add objective', [{path: 'required.md'}]),
    ).rejects.toThrow('unavailable');
    const goal = h.context.getMachine()!;
    expect(goal.snapshot().status).toBe('active');
    expect(goal.snapshot().kickoffAdmissionPending).toBe(true);
    // The durable state survives, while timers and process-local input records do not.
    h.runtime.pendingKickoffDispatch?.clear();
    h.runtime.clearKickoffTimer?.(sessionID);
    await expect(h.execute('resume')).rejects.toThrow(
      'original kickoff inputs',
    );
    expect(h.prompts).toHaveLength(1);
    h.setPrompt(async () => ({}));
    await h.execute('resume', [{path: 'required.md'}]);
    expect(h.prompts).toHaveLength(2);
    expect(goal.snapshot().kickoffAdmissionPending).toBe(false);
  } finally {
    clock.restore();
  }
});

for (const onRetry of [false, true]) {
  for (const throws of [false, true]) {
    test(`known host success followed by persistence failure does not resend (${onRetry ? 'retry' : 'initial'}, ${throws ? 'throw' : 'false'})`, async () => {
      const clock = timers();
      try {
        const h = await harness();
        if (onRetry) {
          h.setPrompt(async () => {
            throw new Error('unavailable');
          });
          await expect(
            h.execute('add objective', [{path: 'required.md'}]),
          ).rejects.toThrow('unavailable');
        }
        h.setPrompt(async () => {
          h.context.persist = async () => {
            if (throws) throw new Error('simulated disk write failure');
            return false;
          };
          return {};
        });
        if (onRetry) {
          clock.fire();
          await drainUntil(() => h.announcements.length === 1);
          expect(h.announcements[0]).toContain('was admitted');
        } else {
          await expect(
            h.execute('add objective', [{path: 'required.md'}]),
          ).rejects.toThrow('was admitted');
        }
        await drain();
        expect(h.prompts).toHaveLength(onRetry ? 2 : 1);
        expect(h.pending('goal-1')).toBeUndefined();
        expect(clock.callbacks.size).toBe(0);
        expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(false);
        expect(h.context.getMachine()?.snapshot().kickoffAdmissionPending).toBe(
          false,
        );
      } finally {
        clock.restore();
      }
    });
  }
}

for (const onRetry of [false, true]) {
  for (const intervention of ['pause', 'fence']) {
    test(`${intervention} during marker persistence prevents host admission (${onRetry ? 'retry' : 'initial'})`, async () => {
      const clock = timers();
      try {
        const h = await harness();
        if (onRetry) {
          h.setPrompt(async () => {
            throw new Error('unavailable');
          });
          await expect(
            h.execute('add objective', [{path: 'required.md'}]),
          ).rejects.toThrow('unavailable');
        }
        const persisted = deferred();
        const originalPersist = h.context.persist;
        let held = false;
        h.context.persist = async () => {
          if (!held && h.pending('goal-1')?.inFlight) {
            held = true;
            await persisted.promise;
          }
          return originalPersist();
        };
        h.setPrompt(async () => ({}));
        let initial: Promise<unknown> | undefined;
        if (onRetry) {
          clock.fire();
        } else {
          initial = h
            .execute('add objective', [{path: 'required.md'}])
            .catch(error => error);
        }
        await drainUntil(() => held);
        if (intervention === 'pause') await h.execute('pause');
        else h.runtime.canDriveSession = () => false;
        expect(h.context.getMachine()?.snapshot().status).toBe(
          intervention === 'pause' ? 'paused' : 'active',
        );
        persisted.resolve();
        if (initial) expect(String(await initial)).toContain('Goal changed');
        await drain();
        expect(h.prompts).toHaveLength(onRetry ? 1 : 0);
        expect(h.pending('goal-1')).toBeDefined();
        expect(h.pending('goal-1')?.inFlight).toBe(false);
        if (intervention === 'fence' && clock.callbacks.size) {
          clock.fire();
          await drain();
          expect(h.prompts).toHaveLength(onRetry ? 1 : 0);
        }
        expect(clock.callbacks.size).toBe(0);
        expect(h.runtime.promptInFlightSessions.has(sessionID)).toBe(false);
        h.runtime.canDriveSession = () => true;
        await h.execute('resume');
        expect(h.prompts.at(-1)?.files).toEqual([{path: 'required.md'}]);
        expect(h.pending('goal-1')).toBeUndefined();
      } finally {
        clock.restore();
      }
    });
  }
}

test('goal-command edit reactivates a retry-exhausted goal and clears exhausted', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add objective', [{path: 'required.md'}]),
    ).rejects.toThrow('unavailable');
    for (let i = 0; i < 3; i++) {
      clock.fire();
      await drain();
    }
    expect(h.context.getMachineById('goal-1')?.snapshot().status).toBe(
      'paused',
    );
    expect(h.pending('goal-1')?.exhausted).toBe(true);
    h.setPrompt(async () => ({}));
    const edited = await h.wiring.executeSlashCommand(
      {sessionID, command: 'goal', arguments: 'edit goal-1 updated objective'},
      {skipReplayRecord: true, source: 'goal-command'},
    );
    expect(edited.ok).toBe(true);
    expect(h.pending('goal-1')?.exhausted).toBe(false);
    expect(h.pending('goal-1')?.attempts).toBe(0);
    expect(clock.callbacks.size).toBe(1);
    clock.fire();
    await drainUntil(() => h.pending('goal-1') === undefined);
    expect(h.prompts).toHaveLength(5);
    expect(h.prompts[4].files).toEqual([{path: 'required.md'}]);
  } finally {
    clock.restore();
  }
});

test('attachment-free synthetic kickoff exhaustion does not claim attachments or block post-restart resume', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setSynthetic(async () => {
      throw new Error('synthetic unavailable');
    });
    await expect(h.execute('add plain objective')).rejects.toThrow(
      'synthetic unavailable',
    );
    for (let i = 0; i < 3; i++) {
      clock.fire();
      await drain();
    }
    const snap = h.context.getMachineById('goal-1')?.snapshot();
    expect(snap?.status).toBe('paused');
    expect(snap?.kickoffAdmissionPending).toBe(false);
    expect(h.announcements.at(-1)).not.toContain('attachments are retained');
    // Simulate restart by dropping in-memory retained dispatch.
    h.runtime.pendingKickoffDispatch?.delete(sessionID);
    h.setSynthetic(async () => ({}));
    await h.execute('resume goal-1');
    expect(h.context.getMachineById('goal-1')?.snapshot().status).toBe(
      'active',
    );
  } finally {
    clock.restore();
  }
});

test('resubmitting structurally identical object attachments on resume deduplicates them', async () => {
  const clock = timers();
  try {
    const h = await harness();
    h.setPrompt(async () => {
      throw new Error('unavailable');
    });
    await expect(
      h.execute('add objective', [{uri: 'file:///a.md', name: 'a.md'}]),
    ).rejects.toThrow('unavailable');
    await h.execute('pause');
    h.setPrompt(async () => ({}));
    await h.execute('resume', [
      {uri: 'file:///a.md', name: 'a.md'},
      {uri: 'file:///b.md', name: 'b.md'},
    ]);
    expect(h.prompts.at(-1)?.files).toEqual([
      {uri: 'file:///a.md', name: 'a.md'},
      {uri: 'file:///b.md', name: 'b.md'},
    ]);
  } finally {
    clock.restore();
  }
});

test('failed attached edit rolls back kickoffAdmissionPending', async () => {
  const h = await harness();
  const machine = h.context.createGoal('objective', {});
  await machine.transition('paused', {
    source: 'slash-command',
    stopReason: 'paused',
  });
  const origTransition = machine.transition.bind(machine);
  machine.transition = async () => ({
    ok: false,
    error: 'simulated transition failure',
  });
  try {
    await expect(
      h.execute('edit new objective', [{path: 'a.md'}]),
    ).rejects.toThrow('simulated transition failure');
    expect(machine.snapshot().kickoffAdmissionPending).toBe(false);
  } finally {
    machine.transition = origTransition;
  }
});

test('attached edit recovers a post-restart active goal with kickoffAdmissionPending and no retained dispatch', async () => {
  const h = await harness();
  const machine = h.context.createGoal('original objective', {
    kickoffAdmissionPending: true,
  });
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().kickoffAdmissionPending).toBe(true);
  expect(h.pending('goal-1')).toBeUndefined();
  await h.execute('edit updated objective', [{path: 'restored.md'}]);
  expect(machine.snapshot().condition).toBe('updated objective');
  expect(machine.snapshot().status).toBe('active');
  expect(machine.snapshot().kickoffAdmissionPending).toBe(false);
  expect(h.prompts).toHaveLength(1);
  expect(h.prompts[0].files).toEqual([{path: 'restored.md'}]);
});
