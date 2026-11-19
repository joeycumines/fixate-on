import {describe, expect, spyOn, test} from 'bun:test';
import {
  createChildSessionJudge,
  createChildSessionVerifier,
} from '../src/child-session-verifier.ts';
import {createGoalState} from '../src/state-machine.ts';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {createOpencodeClient} from '@opencode-ai/sdk/client';
import {verifierSessionID, verifierSessionInfo} from './verifier-fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

const goal = createGoalState('cleanup-parent', 'Finish the task', {
  goalId: 'cleanup-goal',
  runId: 'cleanup-run',
});
const input = {
  cwd: '/cleanup-workspace',
  taskId: goal.goalId,
  candidateIdentity: {candidate: 'candidate', fingerprint: 'fingerprint'},
  goal,
  latestText: 'Done',
};
const complete = {
  schema_version: 1,
  task_id: goal.goalId,
  state: 'COMPLETE',
  candidate: 'candidate',
  fingerprint: 'fingerprint',
  outstanding: [],
  evidence: ['The command verifier exited zero.'],
};
const reply = {parts: [{type: 'text', text: JSON.stringify(complete)}]};
const child = {id: 'cleanup-child', parentID: goal.sessionID};
const nextTick = () => new Promise<void>(resolve => setImmediate(resolve));

function host() {
  const calls = {
    create: 0,
    get: 0,
    prompt: 0,
    messages: 0,
    delete: 0,
    abort: 0,
  };
  const session = {
    create: async (): Promise<unknown> => {
      calls.create++;
      return child;
    },
    get: async (arg: unknown): Promise<unknown> => {
      calls.get++;
      return verifierSessionID(arg) === goal.sessionID
        ? verifierSessionInfo(arg, input.cwd)
        : {...child, location: {directory: input.cwd}};
    },
    prompt: async (): Promise<unknown> => {
      calls.prompt++;
      return reply;
    },
    messages: async (): Promise<unknown> => {
      calls.messages++;
      return [];
    },
    delete: async (): Promise<unknown> => {
      calls.delete++;
      return {};
    },
    abort: async (): Promise<unknown> => {
      calls.abort++;
      return {};
    },
  };
  return {client: {session}, calls};
}

describe('verifier child cleanup is part of the outcome', () => {
  test('legacy approve policy cannot turn a judge rejection into approval on cleanup failure', async () => {
    const {client} = host();
    client.session.prompt = async () => ({
      parts: [{type: 'text', text: 'Missing test evidence.\n[judge:rejected]'}],
    });
    client.session.delete = async () => {
      throw new Error('storage unavailable');
    };
    const outcome = await createChildSessionJudge(client, {
      failurePolicy: 'approve',
    })({goal, sessionID: goal.sessionID, latestText: 'Done'});
    expect(outcome.approved).toBe(false);
    expect(outcome.reason).toContain('Missing test evidence.');
    expect(outcome.reason).toContain('storage unavailable');
  });

  for (const failurePolicy of ['reject', 'approve'] as const) {
    test(`clean COMPLETE survives ${failurePolicy} and deletes exactly once`, async () => {
      const {client, calls} = host();
      const verdict = await createChildSessionVerifier(client, {failurePolicy})(
        input,
      );
      expect(verdict.state).toBe('COMPLETE');
      expect(calls.delete).toBe(1);
    });
  }

  test('a cleanup fault converts COMPLETE to WORKING under approve', async () => {
    const {client} = host();
    client.session.delete = async () => {
      throw new Error('storage unavailable');
    };
    const verdict = await createChildSessionVerifier(client, {
      failurePolicy: 'approve',
    })(input);
    expect(verdict.state).toBe('WORKING');
    expect(verdict.outstanding.join(' ')).toContain('storage unavailable');
  });

  test('reject preserves both the prompt fault and cleanup fault', async () => {
    const {client} = host();
    const promptError = new Error('prompt unavailable');
    client.session.prompt = async () => {
      throw promptError;
    };
    client.session.delete = async () => {
      throw new Error('storage unavailable');
    };
    const failure = await createChildSessionVerifier(client)(input).catch(
      error => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain('prompt unavailable');
    expect(failure.message).toContain('storage unavailable');
  });

  test('approve keeps both operational faults in its WORKING receipt', async () => {
    const {client} = host();
    client.session.prompt = async () => {
      throw new Error('prompt unavailable');
    };
    client.session.delete = async () => {
      throw new Error('storage unavailable');
    };
    const verdict = await createChildSessionVerifier(client, {
      failurePolicy: 'approve',
    })(input);
    expect(verdict.state).toBe('WORKING');
    expect(verdict.outstanding.join(' ')).toContain('prompt unavailable');
    expect(verdict.outstanding.join(' ')).toContain('storage unavailable');
  });

  test('the typed v2 missing-session error for this child is successful cleanup', async () => {
    const {client} = host();
    // v2.2.7 Session.NotFoundError is an Effect tagged Error with an empty
    // message. Its structured tag and session ID identify the missing child.
    client.session.delete = async () => {
      throw Object.assign(new Error(''), {
        _tag: 'Session.NotFoundError',
        sessionID: child.id,
      });
    };
    expect((await createChildSessionVerifier(client)(input)).state).toBe(
      'COMPLETE',
    );
  });

  test('a missing-session error for another ID is still a cleanup fault', async () => {
    const {client} = host();
    client.session.delete = async () => {
      throw {_tag: 'Session.NotFoundError', sessionID: 'another-child'};
    };
    await expect(createChildSessionVerifier(client)(input)).rejects.toThrow(
      'cleanup failed',
    );
  });

  test('a route-not-found message is not evidence that the child is gone', async () => {
    const {client} = host();
    client.session.delete = async () => {
      throw new Error('DELETE /api/session route not found');
    };
    await expect(createChildSessionVerifier(client)(input)).rejects.toThrow(
      'cleanup failed',
    );
  });

  for (const failurePolicy of ['reject', 'approve'] as const) {
    test(`the real v1 SDK cannot hide a DELETE error envelope under ${failurePolicy}`, async () => {
      const calls: string[] = [];
      // The installed SDK defaults to returning {error, request, response}
      // for HTTP errors. Exercise that real response decoder with no network.
      const client = createOpencodeClient({
        baseUrl: 'http://sdk.invalid',
        fetch: async request => {
          const path = new URL(request.url).pathname;
          calls.push(`${request.method} ${path}`);
          const json = (value: unknown, status = 200) =>
            new Response(JSON.stringify(value), {
              status,
              headers: {'content-type': 'application/json'},
            });
          if (request.method === 'DELETE')
            return json(
              {
                name: 'StorageError',
                data: {message: 'delete storage unavailable'},
              },
              500,
            );
          if (request.method === 'POST' && path === '/session')
            return json(child);
          if (request.method === 'GET' && path === `/session/${goal.sessionID}`)
            return json({id: goal.sessionID, directory: input.cwd});
          if (request.method === 'GET' && path === `/session/${child.id}`)
            return json({...child, directory: input.cwd});
          if (
            request.method === 'POST' &&
            path === `/session/${child.id}/message`
          )
            return json(reply);
          throw new Error(`Unexpected SDK request: ${request.method} ${path}`);
        },
      });
      const running = createChildSessionVerifier(client, {failurePolicy})(
        input,
      );
      if (failurePolicy === 'approve') {
        const outcome = await running;
        expect(outcome.state).toBe('WORKING');
        expect(outcome.outstanding.join(' ')).toContain(
          'delete storage unavailable',
        );
      } else {
        await expect(running).rejects.toThrow('delete storage unavailable');
      }
      expect(calls.filter(call => call.startsWith('DELETE '))).toHaveLength(1);
    });
  }

  test('a host without deletion is rejected before creating an orphan', async () => {
    const {client, calls} = host();
    const {delete: unusedDelete, ...session} = client.session;
    void unusedDelete;
    await expect(createChildSessionVerifier({session})(input)).rejects.toThrow(
      'cleanup unsupported',
    );
    expect(calls.create).toBe(0);
  });

  test('a v2 host without remove is rejected before creating an orphan', async () => {
    const {client, calls} = host();
    const shim = createV2ClientShim(
      {
        session: {
          ...client.session,
          switchAgent: async () => {},
        },
      } as never,
      {bySession: new Map()},
    );
    const outcome = await createChildSessionVerifier(shim, {
      failurePolicy: 'approve',
    })(input);
    expect(outcome.state).toBe('WORKING');
    expect(outcome.outstanding.join(' ')).toContain('cleanup unsupported');
    expect(calls.create).toBe(0);
    expect(calls.prompt).toBe(0);
    // Direct use of the shim's unsupported mutation must still fail loudly.
    await expect(shim.session.delete!({sessionID: child.id})).rejects.toThrow(
      'deletion unsupported',
    );
  });

  test('a v2 child selects the verifier before checking its initial agent', async () => {
    const {client, calls} = host();
    let selected = 'build';
    const events: string[] = [];
    const shim = createV2ClientShim(
      {
        session: {
          ...client.session,
          switchAgent: async ({agent}: {agent: string}) => {
            selected = agent;
            events.push(`select:${agent}`);
          },
          get: async (arg: unknown) => {
            if (verifierSessionID(arg) === goal.sessionID) {
              return verifierSessionInfo(arg, input.cwd);
            }
            events.push(`get:${selected}`);
            return {
              ...child,
              agent: selected,
              location: {directory: input.cwd},
            };
          },
          prompt: async () => {
            events.push(`prompt:${selected}`);
            return reply;
          },
          remove: client.session.delete,
        },
      } as never,
      {bySession: new Map()},
    );
    const outcome = await createChildSessionVerifier(shim)(input);
    expect(outcome.state).toBe('COMPLETE');
    expect(events.indexOf('select:goal-verify')).toBeLessThan(
      events.indexOf('get:goal-verify'),
    );
    expect(events).toContain('prompt:goal-verify');
    expect(events.at(-1)).toBe('get:goal-verify');
    expect(calls.delete).toBe(1);
  });

  test('a host ignoring agent selection is rejected before prompting', async () => {
    const {client, calls} = host();
    const shim = createV2ClientShim(
      {
        session: {
          ...client.session,
          switchAgent: async () => {},
          get: async (arg: unknown) =>
            verifierSessionID(arg) === goal.sessionID
              ? verifierSessionInfo(arg, input.cwd)
              : {
                  ...child,
                  agent: 'build',
                  location: {directory: input.cwd},
                },
          remove: client.session.delete,
        },
      } as never,
      {bySession: new Map()},
    );
    await expect(createChildSessionVerifier(shim)(input)).rejects.toThrow(
      'agent build',
    );
    expect(calls.prompt).toBe(0);
    expect(calls.delete).toBe(1);
  });

  test('a workspace move during the prompt invalidates the returned verdict', async () => {
    const {client, calls} = host();
    let directory = input.cwd;
    client.session.get = async (arg: unknown) => {
      calls.get++;
      return verifierSessionID(arg) === goal.sessionID
        ? verifierSessionInfo(arg, input.cwd)
        : {...child, location: {directory}};
    };
    client.session.prompt = async () => {
      directory = '/another-workspace';
      return reply;
    };
    await expect(createChildSessionVerifier(client)(input)).rejects.toThrow(
      'workspace location does not match',
    );
    // One parent-policy lookup plus workspace validation before and after the
    // prompt; the post-prompt read detects the moved workspace.
    expect(calls.get).toBe(3);
    expect(calls.delete).toBe(1);
  });
});

describe('timeout and cleanup ownership', () => {
  test('late creation with the wrong parent still deletes once and never reads or prompts', async () => {
    const created = deferred<unknown>();
    const deleted = deferred<void>();
    const {client, calls} = host();
    client.session.create = () => created.promise;
    client.session.delete = async () => {
      calls.delete++;
      deleted.resolve();
    };
    await expect(
      createChildSessionVerifier(client, {timeoutMs: 5})(input),
    ).rejects.toThrow('timed out');
    created.resolve({...child, parentID: 'wrong-parent'});
    await deleted.promise;
    await nextTick();
    expect(calls.delete).toBe(1);
    // The one lookup is the parent policy read; the late child is cleaned by
    // its retained ID, never by a get that could still be in flight.
    expect(calls.get).toBe(1);
    expect(calls.prompt).toBe(0);
  });

  test('timing out during get starts one delete and prevents a late prompt', async () => {
    const lookup = deferred<unknown>();
    const {client, calls} = host();
    client.session.get = (arg: unknown) =>
      verifierSessionID(arg) === goal.sessionID
        ? Promise.resolve(verifierSessionInfo(arg, input.cwd))
        : lookup.promise;
    await expect(
      createChildSessionVerifier(client, {timeoutMs: 5})(input),
    ).rejects.toThrow('timed out');
    lookup.resolve({...child, location: {directory: input.cwd}});
    await nextTick();
    expect(calls.abort).toBe(1);
    expect(calls.delete).toBe(1);
    expect(calls.prompt).toBe(0);
  });

  test('timing out during prompt never reads fallback messages after deletion', async () => {
    const prompt = deferred<unknown>();
    const {client, calls} = host();
    client.session.prompt = () => prompt.promise;
    await expect(
      createChildSessionVerifier(client, {timeoutMs: 5})(input),
    ).rejects.toThrow('timed out');
    prompt.resolve({});
    await nextTick();
    expect(calls.abort).toBe(1);
    expect(calls.delete).toBe(1);
    expect(calls.messages).toBe(0);
  });

  test('timing out during v2 prompt agent selection prevents a late host prompt', async () => {
    const selection = deferred<void>();
    const started = deferred<void>();
    const {client, calls} = host();
    let selections = 0;
    let selectedAgent: string | undefined;
    const shim = createV2ClientShim(
      {
        session: {
          ...client.session,
          get: async (arg: unknown) =>
            verifierSessionID(arg) === goal.sessionID
              ? verifierSessionInfo(arg, input.cwd)
              : {
                  ...child,
                  agent: selectedAgent,
                  location: {directory: input.cwd},
                },
          switchAgent: async ({agent}: {agent: string}) => {
            selections++;
            selectedAgent = agent;
            if (selections === 2) {
              started.resolve();
              await selection.promise;
            }
          },
          remove: client.session.delete,
          interrupt: client.session.abort,
        },
      } as never,
      {bySession: new Map()},
    );
    const running = createChildSessionVerifier(shim, {timeoutMs: 20})(input);
    const assertion = expect(running).rejects.toThrow('timed out');
    await started.promise;
    await assertion;
    selection.resolve();
    await nextTick();
    expect(calls.prompt).toBe(0);
    expect(calls.delete).toBe(1);
    expect(calls.abort).toBe(1);
  });

  test('cleanup is inside the deadline and its in-flight deletion is never duplicated', async () => {
    const deletion = deferred<unknown>();
    const {client, calls} = host();
    client.session.delete = () => {
      calls.delete++;
      return deletion.promise;
    };
    const running = createChildSessionVerifier(client, {timeoutMs: 5})(input);
    // A pending deletion must not defeat the configured deadline. The host
    // operation remains in flight and may finish after the caller gets a fault.
    let guard: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      running.then(
        () => 'complete',
        () => 'fault',
      ),
      new Promise<string>(resolve => {
        guard = setTimeout(() => resolve('hung'), 100);
      }),
    ]);
    clearTimeout(guard);
    deletion.resolve({});
    await running.catch(() => {});
    expect(outcome).toBe('fault');
    expect(calls.delete).toBe(1);
  });

  test('a cleanup deadline keeps the earlier prompt fault in the receipt', async () => {
    const deletion = deferred<unknown>();
    const {client} = host();
    client.session.prompt = async () => {
      throw new Error('prompt unavailable');
    };
    client.session.delete = () => deletion.promise;
    const verdict = await createChildSessionVerifier(client, {
      timeoutMs: 5,
      failurePolicy: 'approve',
    })(input);
    deletion.resolve({});
    expect(verdict.state).toBe('WORKING');
    expect(verdict.outstanding.join(' ')).toContain('prompt unavailable');
    expect(verdict.outstanding.join(' ')).toContain('timed out');
  });

  test('legacy judge also cleans a late-created child with a wrong parent', async () => {
    const created = deferred<unknown>();
    const {client, calls} = host();
    client.session.create = () => created.promise;
    const result = await createChildSessionJudge(client, {timeoutMs: 5})({
      goal,
      sessionID: goal.sessionID,
      latestText: 'Done',
    });
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('timed out');
    created.resolve({...child, parentID: 'wrong-parent'});
    await nextTick();
    expect(calls.delete).toBe(1);
    expect(calls.prompt).toBe(0);
  });

  test('late cleanup failure is reported once after the timeout receipt', async () => {
    const created = deferred<unknown>();
    const {client, calls} = host();
    client.session.create = () => created.promise;
    client.session.delete = async () => {
      calls.delete++;
      throw new Error('late storage failure');
    };
    const log = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        createChildSessionVerifier(client, {timeoutMs: 5})(input),
      ).rejects.toThrow('timed out');
      created.resolve(child);
      await nextTick();
      expect(calls.delete).toBe(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0])).toContain('late storage failure');
    } finally {
      log.mockRestore();
    }
  });

  test('HTTP SDK 404 SessionNotFoundError envelope in SessionApiError.cause cleans up cleanly', async () => {
    const {client, calls} = host();
    client.session.delete = async () => {
      calls.delete++;
      return {
        error: {_tag: 'SessionNotFoundError', sessionID: child.id, message: ''},
        response: {status: 404},
      };
    };
    const verdict = await createChildSessionVerifier(client)(input);
    expect(verdict.state).toBe('COMPLETE');
    expect(calls.delete).toBe(1);
  });
});
