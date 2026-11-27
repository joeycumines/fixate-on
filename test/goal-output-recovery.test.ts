import {describe, expect, test} from 'bun:test';
import {
  createGoalOutputPublisher,
  type GoalCommandOutput,
  type GoalOutputRpcDomain,
} from '../src/plugin-v2-command-output.ts';
import {wireGoalCommandOutput} from '../src/tui-v2-command-output.ts';
import {deferred} from './wait-for.ts';

function receipt(
  id: string,
  sessionID = 'one',
  kind: GoalCommandOutput['kind'] = 'command',
): GoalCommandOutput {
  return {id, sessionID, kind, text: id, timestamp: 1};
}

function outputFixture() {
  const listeners = new Map<string, (event: unknown) => void>();
  const requests: Array<ReturnType<typeof deferred<unknown>>> = [];
  const shown: string[] = [];
  const toasts: string[] = [];
  let failDisplay = false;
  let onDisplay: (() => void) | undefined;
  const dispose = wireGoalCommandOutput(
    {
      client: {
        rpc: () => ({
          latest: () => {
            const request = deferred<unknown>();
            requests.push(request);
            return request.promise;
          },
        }),
      },
      data: {
        on: (type, listener) => {
          listeners.set(type, listener);
          return () => listeners.delete(type);
        },
      },
      ui: {
        router: {current: () => ({type: 'session', sessionID: 'one'})},
        toast: {show: input => toasts.push(input.message)},
      },
    },
    text => {
      if (failDisplay) throw new Error('dialog unavailable');
      shown.push(text);
      onDisplay?.();
    },
  );
  return {
    shown,
    toasts,
    dispose,
    failDisplay: (fail: boolean) => {
      failDisplay = fail;
    },
    onDisplay: (callback: () => void) => {
      onDisplay = callback;
    },
    live: (data: unknown) =>
      listeners.get('rpc.fixate-on-output.output')?.({data}),
    reconnect: () => listeners.get('server.connected')?.({}),
    resolve: async (index: number, value: unknown) => {
      requests[index].resolve(value);
      await requests[index].promise;
      await Promise.resolve();
    },
  };
}

describe('session-scoped receipt recovery', () => {
  test('another session notice does not suppress the current replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.live(receipt('other notice', 'two', 'notice'));
      await fixture.resolve(0, receipt('recovered command'));
      expect(fixture.toasts).toEqual(['other notice']);
      expect(fixture.shown).toEqual(['recovered command']);
    } finally {
      fixture.dispose();
    }
  });

  test('malformed live output does not suppress a valid replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.live({...receipt('invalid'), timestamp: Infinity});
      await fixture.resolve(0, receipt('recovered command'));
      expect(fixture.shown).toEqual(['recovered command']);
      expect(fixture.toasts).toEqual([]);
    } finally {
      fixture.dispose();
    }
  });

  test('a failed live display can be retried by the pending replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.failDisplay(true);
      fixture.live(receipt('retry display'));
      fixture.failDisplay(false);
      await fixture.resolve(0, receipt('retry display'));
      expect(fixture.shown).toEqual(['retry display']);
    } finally {
      fixture.dispose();
    }
  });

  test('an already displayed duplicate does not suppress a newer replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.live(receipt('old'));
      await fixture.resolve(0, receipt('old'));
      fixture.reconnect();
      fixture.live(receipt('old'));
      await fixture.resolve(1, receipt('new'));
      expect(fixture.shown).toEqual(['old', 'new']);
    } finally {
      fixture.dispose();
    }
  });

  test('a successfully displayed live receipt supersedes an older replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.live(receipt('live'));
      await fixture.resolve(0, receipt('older replay'));
      expect(fixture.shown).toEqual(['live']);
    } finally {
      fixture.dispose();
    }
  });

  test('an older live receipt cannot suppress a newer pending replay', async () => {
    const fixture = outputFixture();
    try {
      fixture.live({...receipt('delayed live'), timestamp: 10});
      await fixture.resolve(0, {...receipt('latest replay'), timestamp: 11});
      expect(fixture.shown).toEqual(['delayed live', 'latest replay']);
    } finally {
      fixture.dispose();
    }
  });

  test('an out-of-order live receipt cannot lower the pending recovery watermark', async () => {
    const fixture = outputFixture();
    try {
      fixture.live({...receipt('newest live'), timestamp: 12});
      fixture.live({...receipt('delayed live'), timestamp: 10});
      await fixture.resolve(0, {...receipt('older replay'), timestamp: 11});
      expect(fixture.shown).toEqual(['newest live', 'delayed live']);
    } finally {
      fixture.dispose();
    }
  });

  test('a newer reconnect supersedes an older pending recovery', async () => {
    const fixture = outputFixture();
    try {
      fixture.reconnect();
      await fixture.resolve(1, receipt('new recovery'));
      await fixture.resolve(0, receipt('old recovery'));
      expect(fixture.shown).toEqual(['new recovery']);
    } finally {
      fixture.dispose();
    }
  });

  test('displaying live output cannot cancel a reconnect started by that display', async () => {
    const fixture = outputFixture();
    try {
      fixture.onDisplay(() => {
        fixture.onDisplay(() => {});
        fixture.reconnect();
      });
      fixture.live(receipt('live'));
      await fixture.resolve(1, receipt('new recovery'));
      await fixture.resolve(0, receipt('old recovery'));
      expect(fixture.shown).toEqual(['live', 'new recovery']);
    } finally {
      fixture.dispose();
    }
  });
});

describe('output registration ownership', () => {
  test('receipt order remains strict when the clock repeats or moves backwards', async () => {
    const times = [100, 100, 90];
    const outputs: GoalCommandOutput[] = [];
    const publisher = createGoalOutputPublisher(undefined, () =>
      times.shift()!,
    );
    await publisher.register({
      register: async () => ({
        events: {
          emit: async (_name, output) => {
            outputs.push(output);
          },
        },
        dispose: () => {},
      }),
    });
    try {
      await publisher.publish('one', 'first');
      await publisher.publish('one', 'second');
      await publisher.publish('one', 'third');
      expect(outputs.map(output => output.timestamp)).toEqual([100, 101, 102]);
    } finally {
      await publisher.dispose();
    }
  });

  test('concurrent registration retains exactly one disposable host resource', async () => {
    const ready = deferred<void>();
    let registrations = 0;
    let disposals = 0;
    const rpc: GoalOutputRpcDomain = {
      register: async () => {
        registrations++;
        await ready.promise;
        return {
          events: {emit: async () => {}},
          dispose: () => {
            disposals++;
          },
        };
      },
    };
    const publisher = createGoalOutputPublisher();
    const first = publisher.register(rpc);
    const second = publisher.register(rpc);
    ready.resolve();
    await Promise.all([first, second]);
    await publisher.dispose();
    expect(registrations).toBe(1);
    expect(disposals).toBe(1);
  });

  test('an unsuccessful registration attempt can be retried', async () => {
    let attempts = 0;
    const outputs: GoalCommandOutput[] = [];
    const publisher = createGoalOutputPublisher();
    const rpc: GoalOutputRpcDomain = {
      register: async () => {
        if (++attempts === 1) throw new Error('host reconnecting');
        return {
          events: {
            emit: async (_name, output) => {
              outputs.push(output);
            },
          },
          dispose: () => {},
        };
      },
    };
    await publisher.register(rpc);
    await publisher.register(rpc);
    await publisher.publish('one', 'after reconnect');
    expect(attempts).toBe(2);
    expect(outputs.map(output => output.text)).toEqual(['after reconnect']);
    await publisher.dispose();
  });
});
