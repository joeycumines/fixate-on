import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  createGoalOutputPublisher,
  GOAL_OUTPUT_RPC,
  parseGoalCommandOutput,
  type GoalCommandOutput,
  type GoalOutputRpcDomain,
} from '../src/plugin-v2-command-output.ts';
import {
  wireGoalCommandOutput,
  type GoalOutputTuiContext,
} from '../src/tui-v2-command-output.ts';
import {createV2ClientShim, setup} from '../src/plugin-v2.ts';

function outputHost() {
  const emitted: GoalCommandOutput[] = [];
  let latest: (
    input: unknown,
  ) => Promise<GoalCommandOutput | null> = async () => null;
  let disposed = 0;
  const rpc: GoalOutputRpcDomain = {
    register: async (definition, handlers) => {
      expect(definition).toEqual(GOAL_OUTPUT_RPC);
      latest = handlers.latest;
      return {
        events: {
          emit: async (name, output) => {
            expect(name).toBe('output');
            emitted.push(output);
          },
        },
        dispose: () => {
          disposed++;
        },
      };
    },
  };
  return {
    rpc,
    emitted,
    latest: (input: unknown) => latest(input),
    disposed: () => disposed,
  };
}

describe('passive goal output', () => {
  test('publishes complete receipts and retrieves only the requested session', async () => {
    const host = outputHost();
    const publisher = createGoalOutputPublisher();
    await publisher.register(host.rpc);
    await publisher.publish('one', 'First output', 'command');
    await publisher.publish('two', 'Second output', 'command');
    await publisher.publish('one', 'Updated\nfull receipt', 'command');
    expect(host.emitted).toHaveLength(3);
    expect(await host.latest({sessionID: 'one'})).toMatchObject({
      text: 'Updated\nfull receipt',
      kind: 'command',
      sessionID: 'one',
    });
    expect(await host.latest({sessionID: 'two'})).toMatchObject({
      text: 'Second output',
    });
    expect(await host.latest({sessionID: 'missing'})).toBeNull();
    expect(await host.latest({})).toBeNull();
    expect(new Set(host.emitted.map(output => output.id)).size).toBe(3);
    await publisher.dispose();
    await publisher.dispose();
    expect(host.disposed()).toBe(1);
    expect(await host.latest({sessionID: 'one'})).toBeNull();
    await expect(publisher.publish('one', 'Late output')).rejects.toThrow(
      'disposal',
    );
  });

  test('bounds retained sessions and refreshes a session on a new receipt', async () => {
    const host = outputHost();
    const publisher = createGoalOutputPublisher();
    await publisher.register(host.rpc);
    for (let i = 0; i < 256; i++) await publisher.publish(String(i), 'receipt');
    await publisher.publish('0', 'refreshed');
    await publisher.publish('256', 'last');
    expect(await host.latest({sessionID: '1'})).toBeNull();
    expect(await host.latest({sessionID: '0'})).toMatchObject({
      text: 'refreshed',
    });
    await publisher.dispose();
  });

  test('uses the configured messenger on a host without RPC', async () => {
    const calls: string[] = [];
    const publisher = createGoalOutputPublisher(async (sessionID, text) => {
      calls.push(`${sessionID}:${text}`);
    });
    await publisher.register(undefined);
    await publisher.publish('session', 'Receipt');
    expect(calls).toEqual(['session:Receipt']);
    await publisher.dispose();
  });

  test('a host whose RPC registration throws still uses the configured messenger', async () => {
    const calls: string[] = [];
    const publisher = createGoalOutputPublisher(async (sessionID, text) => {
      calls.push(`${sessionID}:${text}`);
    });
    await publisher.register({
      register: async () => {
        throw new Error('rpc unavailable');
      },
    });
    await publisher.publish('session', 'Receipt');
    expect(calls).toEqual(['session:Receipt']);
    await publisher.dispose();
  });

  test('a missing passive channel surfaces the receipt as an explicit host error', async () => {
    const publisher = createGoalOutputPublisher();
    await publisher.register(undefined);
    await expect(publisher.publish('session', 'Goal paused.')).rejects.toThrow(
      'The goal command completed, but this host has no passive output channel.\nGoal paused.',
    );
    await publisher.dispose();
  });

  test('a rejecting RPC emit does not fail the command and the receipt stays retrievable', async () => {
    let latest:
      ((input: unknown) => Promise<GoalCommandOutput | null>) | undefined;
    const publisher = createGoalOutputPublisher();
    await publisher.register({
      register: async (_definition, handlers) => {
        latest = handlers.latest;
        return {
          dispose: () => {},
          events: {
            emit: async () => {
              throw new Error('output disconnected');
            },
          },
        };
      },
    });
    // Delivery failure must not report an already-successful command as failed.
    await publisher.publish('session', 'Receipt');
    expect(await latest!({sessionID: 'session'})).toMatchObject({
      text: 'Receipt',
    });
    await publisher.dispose();
  });
});

describe('TUI command output', () => {
  test('displays the full active-session receipt without a session API call', async () => {
    let receive: (event: {data: unknown}) => void = () => {};
    const alerts: string[] = [];
    const toasts: Array<{sessionID: string; message: string}> = [];
    let unsubscribed = 0;
    const context: GoalOutputTuiContext = {
      client: {},
      data: {
        on: (name, handler) => {
          if (name === 'rpc.fixate-on-output.output') receive = handler;
          else expect(name).toBe('server.connected');
          return () => {
            unsubscribed++;
          };
        },
      },
      ui: {
        router: {current: () => ({type: 'session', sessionID: 'one'})},
        toast: {
          show: input => {
            toasts.push(input);
          },
        },
      },
    };
    const dispose = wireGoalCommandOutput(context, text => alerts.push(text));
    const output: GoalCommandOutput = {
      id: 'receipt',
      sessionID: 'one',
      text: 'Goal\nFull details',
      kind: 'command',
      timestamp: 1,
    };
    receive({data: output});
    receive({data: output});
    expect(alerts).toEqual(['Goal\nFull details']);
    receive({data: {...output, id: 'other', sessionID: 'two'}});
    receive({
      data: {...output, id: 'notice', kind: 'notice', text: 'Admission paused'},
    });
    expect(alerts).toHaveLength(1);
    expect(toasts.map(item => [item.sessionID, item.message])).toEqual([
      ['two', 'Goal\nFull details'],
      ['one', 'Admission paused'],
    ]);
    receive({data: {id: 'bad', text: 'Malformed'}});
    expect(toasts).toHaveLength(2);
    dispose();
    dispose();
    receive({data: {...output, id: 'late'}});
    expect(alerts).toHaveLength(1);
    expect(unsubscribed).toBe(2);
  });

  test('malformed output is rejected at the display boundary', () => {
    for (const input of [
      null,
      {},
      {id: 'id'},
      {
        id: 'id',
        sessionID: 's',
        text: 'x',
        kind: 'command',
        timestamp: Infinity,
      },
    ]) {
      expect(parseGoalCommandOutput(input)).toBeNull();
    }
  });

  test('recovers a missed receipt on reconnect and deduplicates its live event', async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const pending: Array<(value: unknown) => void> = [];
    const receipts: string[] = [];
    const dispose = wireGoalCommandOutput(
      {
        client: {
          rpc: definition => {
            expect(definition).toEqual(GOAL_OUTPUT_RPC);
            return {
              latest: input => {
                expect(input).toEqual({sessionID: 'one'});
                return new Promise(resolve => pending.push(resolve));
              },
            };
          },
        },
        data: {
          on: (type, handler) => {
            handlers.set(type, handler);
            return () => handlers.delete(type);
          },
        },
        ui: {
          router: {current: () => ({type: 'session', sessionID: 'one'})},
          toast: {show: () => {}},
        },
      },
      text => receipts.push(text),
    );
    const output = {
      id: 'missed',
      sessionID: 'one',
      text: 'Recovered receipt',
      kind: 'command',
      timestamp: 1,
    };
    pending.shift()!(null);
    await Promise.resolve();
    handlers.get('server.connected')!({type: 'server.connected'});
    pending.shift()!(output);
    await Promise.resolve();
    handlers.get('rpc.fixate-on-output.output')!({data: output});
    expect(receipts).toEqual(['Recovered receipt']);
    dispose();
    expect(handlers.size).toBe(0);
  });

  test('a delayed replay cannot replace a live receipt or display after disposal', async () => {
    const handlers = new Map<string, (event: unknown) => void>();
    const pending: Array<(value: unknown) => void> = [];
    const receipts: string[] = [];
    const dispose = wireGoalCommandOutput(
      {
        client: {
          rpc: () => ({
            latest: () => new Promise(resolve => pending.push(resolve)),
          }),
        },
        data: {
          on: (type, handler) => {
            handlers.set(type, handler);
            return () => handlers.delete(type);
          },
        },
        ui: {
          router: {current: () => ({type: 'session', sessionID: 'one'})},
          toast: {show: () => {}},
        },
      },
      text => receipts.push(text),
    );
    const output = {
      id: 'new',
      sessionID: 'one',
      text: 'Current receipt',
      kind: 'command',
      timestamp: 2,
    };
    handlers.get('rpc.fixate-on-output.output')!({data: output});
    pending.shift()!({
      ...output,
      id: 'old',
      text: 'Stale receipt',
      timestamp: 1,
    });
    await Promise.resolve();
    expect(receipts).toEqual(['Current receipt']);
    handlers.get('server.connected')!({});
    dispose();
    pending.shift()!({...output, id: 'late', text: 'After disposal'});
    await Promise.resolve();
    expect(receipts).toEqual(['Current receipt']);
  });

  test('disposes late rpc.register resolution if dispose raced it', async () => {
    let resolveReg!: (reg: {
      events: {
        emit: (name: 'output', output: GoalCommandOutput) => Promise<void>;
      };
      dispose: () => Promise<void>;
    }) => void;
    let disposedCount = 0;
    const publisher = createGoalOutputPublisher();
    const regPromise = publisher.register({
      register: () =>
        new Promise(resolve => {
          resolveReg = resolve;
        }),
    });
    await publisher.dispose();
    resolveReg({
      events: {emit: async () => {}},
      dispose: async () => {
        disposedCount++;
      },
    });
    await regPromise;
    expect(disposedCount).toBe(1);
  });

  test('wireGoalCommandOutput survives unavailable data and throwing UI callbacks', () => {
    const partialDispose = wireGoalCommandOutput(
      {
        client: {},
        data: {} as never,
        ui: {
          router: {current: () => ({type: 'session', sessionID: 'one'})},
          toast: {show: () => {}},
        },
      },
      () => {},
    );
    expect(() => partialDispose()).not.toThrow();

    let receive: (event: {data: unknown}) => void = () => {};
    let throwFirst = true;
    const toasts: string[] = [];
    const dispose = wireGoalCommandOutput(
      {
        client: {},
        data: {
          on: (name, handler) => {
            if (name === 'rpc.fixate-on-output.output') receive = handler;
            return () => {};
          },
        },
        ui: {
          router: {
            current: () => {
              if (throwFirst) {
                throwFirst = false;
                throw new Error('router unavailable');
              }
              return {type: 'other'};
            },
          },
          toast: {
            show: input => {
              toasts.push(input.message);
            },
          },
        },
      },
      () => {},
    );
    expect(() =>
      receive({
        data: {
          id: 'err-1',
          sessionID: 'one',
          text: 'first',
          kind: 'notice',
          timestamp: 1,
        },
      }),
    ).not.toThrow();
    receive({
      data: {
        id: 'ok-2',
        sessionID: 'one',
        text: 'second',
        kind: 'notice',
        timestamp: 2,
      },
    });
    expect(toasts).toEqual(['second']);
    dispose();
  });

  test('setup succeeds when ctx.options is undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fixate-setup-no-opts-'));
    try {
      const dispose = await setup({
        location: {directory: dir},
        options: undefined,
        session: {
          prompt: async () => ({}),
          synthetic: async () => ({}),
          interrupt: async () => ({}),
          create: async () => ({id: 'c1'}),
          get: async () => ({id: 's1'}),
          remove: async () => ({}),
          update: async () => ({}),
          context: async () => [],
        },
      } as never);
      await dispose();
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  test('createV2ClientShim prompt aborts promptly while session.wait is pending', async () => {
    const controller = new AbortController();
    let waitEntered!: () => void;
    const waitStarted = new Promise<void>(resolve => {
      waitEntered = resolve;
    });
    const shim = createV2ClientShim(
      {
        location: {directory: '/tmp'},
        session: {
          prompt: async () => ({id: 'm1'}),
          synthetic: async () => ({}),
          interrupt: async () => ({}),
          create: async () => ({id: 'c1'}),
          get: async () => ({id: 's1'}),
          remove: async () => ({}),
          update: async () => ({}),
          context: async () => [],
          wait: () => {
            waitEntered();
            return new Promise(() => {});
          },
        },
      } as never,
      {bySession: new Map()},
    );
    const promptFn = shim.session.prompt as (
      input: Record<string, unknown>,
      opts?: {signal?: AbortSignal},
    ) => Promise<unknown>;
    const pending = promptFn(
      {sessionID: 's1', parts: [{type: 'text', text: 'hi'}]},
      {signal: controller.signal},
    );
    await waitStarted;
    controller.abort(new Error('timed out'));
    await expect(pending).rejects.toThrow('timed out');
  });
});
