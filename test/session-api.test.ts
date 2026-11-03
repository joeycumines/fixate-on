import {expect, test} from 'bun:test';
import {createOpenCodeSessionApi} from '../src/session-api.ts';

const operations = [
  'messages',
  'promptAsync',
  'prompt',
  'update',
  'get',
  'create',
  'delete',
  'abort',
];

function recordingClient(
  handler: (operation: string, input: unknown) => unknown,
) {
  const calls: {operation: string; input: unknown}[] = [];
  return {
    calls,
    client: {
      session: Object.fromEntries(
        operations.map(operation => [
          operation,
          async (input: unknown) => {
            calls.push({operation, input});
            return handler(operation, input);
          },
        ]),
      ),
    },
  };
}

async function exercise(api: ReturnType<typeof createOpenCodeSessionApi>) {
  return Promise.all([
    api.messages('s1', {limit: 4}),
    api.promptAsync('s2', {parts: [{type: 'text', text: 'continue'}]}),
    api.createChild('parent', {title: 'child'}),
    api.prompt('s3', {parts: []}),
    api.update('s4', {title: 'renamed'}),
    api.delete('s4'),
    api.abort('s5'),
    api.get('s5'),
  ]);
}

test('uses current flattened SDK inputs and normalizes data responses', async () => {
  const host = recordingClient((_operation, input) => ({data: input}));
  const results = await exercise(createOpenCodeSessionApi(host.client));

  expect(host.calls.map(({input}) => input)).toEqual([
    {sessionID: 's1', limit: 4},
    {sessionID: 's2', parts: [{type: 'text', text: 'continue'}]},
    {title: 'child', parentID: 'parent'},
    {sessionID: 's3', parts: []},
    {sessionID: 's4', title: 'renamed'},
    {sessionID: 's4'},
    {sessionID: 's5'},
    {sessionID: 's5'},
  ]);
  expect(results as unknown[]).toEqual(
    host.calls.map(({input}) => input) as unknown[],
  );
});

test('falls back to legacy inputs and remembers read-only operation shapes', async () => {
  const host = recordingClient((_operation, input) => {
    if (
      !(input as Record<string, unknown>).path &&
      !(input as Record<string, unknown>).body
    ) {
      throw new TypeError('validation failed: required path or body');
    }
    return {data: input};
  });
  const api = createOpenCodeSessionApi(host.client);
  await Promise.all([api.messages('s1', {limit: 4}), api.get('s5')]);
  await api.messages('again', {limit: 1});

  const legacyCalls = host.calls.filter(({input}) => {
    const i = input as Record<string, unknown>;
    return i.path || i.body;
  });
  expect(legacyCalls.map(({input}) => input)).toEqual([
    {path: {id: 's1'}, query: {limit: 4}},
    {path: {id: 's5'}},
    {path: {id: 'again'}, query: {limit: 1}},
  ]);
});

test('never replays mutating operations after an argument-shape TypeError', async () => {
  const mutatingCalls: [
    string,
    (api: ReturnType<typeof createOpenCodeSessionApi>) => Promise<unknown>,
    unknown,
    unknown,
  ][] = [
    [
      'promptAsync',
      api => api.promptAsync('s1', {parts: []}),
      {sessionID: 's1', parts: []},
      {
        path: {id: 's1'},
        body: {parts: []},
      },
    ],
    [
      'create',
      api => api.createChild('parent', {title: 'child'}),
      {
        title: 'child',
        parentID: 'parent',
      },
      {body: {title: 'child', parentID: 'parent'}},
    ],
    [
      'prompt',
      api => api.prompt('s2', {parts: []}),
      {sessionID: 's2', parts: []},
      {
        path: {id: 's2'},
        body: {parts: []},
      },
    ],
    [
      'update',
      api => api.update('s3', {title: 'renamed'}),
      {sessionID: 's3', title: 'renamed'},
      {
        path: {id: 's3'},
        body: {title: 'renamed'},
      },
    ],
    ['delete', api => api.delete('s3'), {sessionID: 's3'}, {path: {id: 's3'}}],
    ['abort', api => api.abort('s4'), {sessionID: 's4'}, {path: {id: 's4'}}],
  ];

  for (const preferredShape of ['flat', 'legacy'] as const) {
    for (const [operation, call, flatInput, legacyInput] of mutatingCalls) {
      const host = recordingClient(() => {
        throw new TypeError('validation failed: required path or body');
      });
      const api = createOpenCodeSessionApi(host.client, {preferredShape});
      await expect(call(api)).rejects.toThrow(/validation failed/);
      expect(host.calls).toEqual([
        {operation, input: preferredShape === 'flat' ? flatInput : legacyInput},
      ]);
    }
  }
});

test('does not retry prompts after a real host or provider error', async () => {
  for (const error of [
    new Error('provider rate limit'),
    new TypeError('provider stream decoder crashed'),
  ]) {
    let calls = 0;
    const client = {
      session: {
        promptAsync: async () => {
          calls++;
          throw error;
        },
      },
    };
    const api = createOpenCodeSessionApi(client);
    await expect(api.promptAsync('s', {parts: []})).rejects.toBe(error);
    expect(calls).toBe(1);
  }
});

test('supports an explicit legacy preference without probing', async () => {
  const host = recordingClient((_operation, input) => input);
  const api = createOpenCodeSessionApi(host.client, {preferredShape: 'legacy'});
  await api.get('known');
  expect(host.calls[0].input).toEqual({path: {id: 'known'}});
});

// Session API edge case stress tests

test('throws TypeError for invalid preferredShape', () => {
  const client = {session: {get: async () => null}};
  expect(() =>
    createOpenCodeSessionApi(client, {preferredShape: 'invalid' as 'flat'}),
  ).toThrow(TypeError);
  expect(() =>
    createOpenCodeSessionApi(client, {preferredShape: 'invalid' as 'flat'}),
  ).toThrow('preferredShape');
});

test('throws TypeError when session method is not a function', async () => {
  const client = {session: {messages: 'not-a-function'}};
  const api = createOpenCodeSessionApi(client);
  await expect(api.messages('s1')).rejects.toThrow('not available');
});

test('throws TypeError when session method is undefined', async () => {
  const client = {session: {}};
  const api = createOpenCodeSessionApi(client);
  await expect(api.messages('s1')).rejects.toThrow('not available');
});

test('unwrapData unwraps { data: ... } responses', async () => {
  const host = recordingClient(() => ({data: {id: 'unwrapped'}}));
  const api = createOpenCodeSessionApi(host.client);
  const result = await api.get('s1');
  expect(result).toEqual({id: 'unwrapped'});
});

test('unwrapData returns plain responses as-is', async () => {
  const host = recordingClient(() => ({id: 'plain'}));
  const api = createOpenCodeSessionApi(host.client);
  const result = await api.get('s1');
  expect(result).toEqual({id: 'plain'});
});

test('unwrapData returns null responses as-is', async () => {
  const host = recordingClient(() => null);
  const api = createOpenCodeSessionApi(host.client);
  const result = await api.get('s1');
  expect(result).toBeNull();
});

test('createChild with empty input still sends parentID', async () => {
  const host = recordingClient((_op, input) => input);
  const api = createOpenCodeSessionApi(host.client);
  await api.createChild('parent-1');
  expect(host.calls[0].input).toEqual({parentID: 'parent-1'});
});

test('messages with no options sends just sessionID', async () => {
  const host = recordingClient(() => []);
  const api = createOpenCodeSessionApi(host.client);
  await api.messages('s1');
  expect(host.calls[0].input).toEqual({sessionID: 's1'});
});

test('shape caching — second call uses cached shape without probing', async () => {
  let callCount = 0;
  const client = {
    session: {
      messages: async (input: unknown) => {
        callCount++;
        const i = input as Record<string, unknown>;
        if (!i.path && !i.body)
          throw new TypeError('validation: required path or body');
        return [];
      },
    },
  };
  const api = createOpenCodeSessionApi(client);
  await api.messages('s1', {limit: 5});
  // First call: flat attempt (fails) + legacy attempt (succeeds) = 2 calls
  expect(callCount).toBe(2);
  await api.messages('s2', {limit: 3});
  // Second call: cached legacy shape, no probe = 1 more call
  expect(callCount).toBe(3);
});

test('non-TypeError errors are never retried', async () => {
  let calls = 0;
  const client = {
    session: {
      messages: async () => {
        calls++;
        throw new Error('network timeout');
      },
    },
  };
  const api = createOpenCodeSessionApi(client);
  await expect(api.messages('s1')).rejects.toThrow('network timeout');
  expect(calls).toBe(1);
});

test("TypeError that doesn't match shape patterns is not retried", async () => {
  let calls = 0;
  const client = {
    session: {
      messages: async () => {
        calls++;
        throw new TypeError('completely unrelated error');
      },
    },
  };
  const api = createOpenCodeSessionApi(client);
  await expect(api.messages('s1')).rejects.toThrow(
    'completely unrelated error',
  );
  expect(calls).toBe(1);
});
