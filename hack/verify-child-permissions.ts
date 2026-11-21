/**
 * Exercise the real v2.2.7 host with the child verifier and v2 client adapter.
 * OPENCODE_BINARY=/path/to/opencode bun hack/verify-child-permissions.ts
 * Only the model provider is simulated; session persistence and permissions
 * run through an isolated official host. Logs and JSON evidence stay in /tmp.
 */
import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildVerifierChildPermissions} from '../src/plugin-v2-tools-agents.ts';

const binary = process.env.OPENCODE_BINARY ?? 'opencode';
const version = Bun.spawnSync([binary, '--version']);
assert.equal(version.exitCode, 0);
const hostVersion = version.stdout.toString().trim();
assert.match(hostVersion, /\bv?2\./, 'Expected an OpenCode v2 binary.');
const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'fixate-review-global-policy-')),
);
const work = join(root, 'work');
const plugin = join(root, 'plugin');
const configDir = join(root, 'config', 'opencode');
for (const directory of [work, plugin, configDir])
  mkdirSync(directory, {recursive: true});
assert.equal(Bun.spawnSync(['git', 'init', '-q'], {cwd: work}).exitCode, 0);
const fixtureName = 'restricted-fixture.txt';
const fixtureMarker = 'REVIEW_SENTINEL_NOT_REAL_DATA_6b94106f74d8';
writeFileSync(join(work, fixtureName), fixtureMarker + '\n');
const fixtureRPC = 'fixate-on-verifier-permissions-test';
const fixtureEntry = join(root, 'verifier-fixture.ts');
// Run the verifier inside the plugin's real Context. An HTTP imitation cannot
// implement the host prompt hook where the verifier refreshes permission policy.
writeFileSync(
  fixtureEntry,
  `
import GoalsPluginV2, {createV2ClientShim} from ${JSON.stringify(resolve(import.meta.dir, '../src/plugin-v2.ts'))};
import {createChildSessionVerifier} from ${JSON.stringify(resolve(import.meta.dir, '../src/child-session-verifier.ts'))};
import {createGoalState} from ${JSON.stringify(resolve(import.meta.dir, '../src/state-machine.ts'))};

function unwrap(value) {
  return value && typeof value === 'object' && 'data' in value ? value.data : value;
}

export default {
  ...GoalsPluginV2,
  async setup(ctx) {
    const disposeGoal = await GoalsPluginV2.setup(ctx);
    let registration;
    try {
      registration = await ctx.rpc.register({
        id: ${JSON.stringify(fixtureRPC)},
        methods: {
          verify: {
            input: {
              type: 'object',
              properties: {
                parentID: {type: 'string', minLength: 1},
                initialAgent: {type: 'string'},
              },
              required: ['parentID'],
              additionalProperties: false,
            },
            output: {type: 'object', additionalProperties: true},
          },
        },
        events: {},
      }, {
        verify: async ({parentID, initialAgent}) => {
          const created = [];
          const parentObserved = [];
          const childObserved = [];
          const updates = [];
          const operations = [];
          const observedSession = new Proxy(ctx.session, {
            get(target, key, receiver) {
              const method = Reflect.get(target, key, receiver);
              if (typeof method !== 'function') return method;
              if (key === 'hook') {
                return async (name, callback) => {
                  const reg = await method.call(target, name, async event => {
                    const observed = name === 'prompt' && event.sessionID === created[0]?.id;
                    if (observed) operations.push('admission:start');
                    await callback(event);
                    if (observed) operations.push('admission:complete');
                  });
                  operations.push('hook:' + name + ':register');
                  return {
                    ...reg,
                    async dispose() {
                      await reg.dispose();
                      operations.push('hook:' + name + ':dispose');
                    },
                  };
                };
              }
              return async (...args) => {
                const input = args[0] ?? {};
                if (key === 'create' && initialAgent) {
                  args[0] = {...input, agent: initialAgent};
                }
                if (key === 'prompt') operations.push('prompt:begin');
                const raw = await method.apply(target, args);
                const info = unwrap(raw);
                if (key === 'create') {
                  created.push(structuredClone(info));
                  operations.push('create:' + info.agent);
                } else if (key === 'get') {
                  const observed = input.sessionID === parentID ? parentObserved : childObserved;
                  observed.push(structuredClone(info));
                  operations.push('get:' + info.agent);
                } else if (key === 'update') {
                  updates.push({input: structuredClone(input), result: structuredClone(info ?? null)});
                  operations.push('update');
                } else if (key === 'switchAgent') {
                  operations.push('select:' + input.agent);
                } else if (key === 'prompt') {
                  operations.push('prompt:accepted');
                } else {
                  operations.push(String(key));
                }
                return raw;
              };
            },
          });
          const shim = createV2ClientShim(
            {...ctx, session: observedSession},
            {bySession: new Map()},
          );
          const goal = createGoalState(parentID, 'Exercise the verifier host transport', {
            goalId: 'live-verifier-goal',
            runId: 'live-verifier-run',
          });
          const verdict = await createChildSessionVerifier(shim, {timeoutMs: 15_000})({
            goal,
            taskId: goal.goalId,
            cwd: ctx.location.directory,
            latestText: 'Controlled completion claim',
            candidateIdentity: {candidate: 'integration', fingerprint: 'integration'},
          });
          return {created, parentObserved, childObserved, updates, operations, verdict};
        },
      });
    } catch (error) {
      await disposeGoal();
      throw error;
    }
    return async () => {
      await registration.dispose();
      await disposeGoal();
    };
  },
};
`,
);
const built = await Bun.build({
  entrypoints: [fixtureEntry],
  target: 'bun',
  outdir: plugin,
  naming: 'server.js',
});
assert.ok(built.success, String(built.logs));

interface ModelRequest {
  model?: string;
  messages?: unknown[];
  tools?: Array<{function?: {name?: string}; name?: string}>;
}
interface SessionInfo {
  id: string;
  parentID?: string;
  agent?: string;
  permissions?: unknown[];
  location?: {directory?: string};
}
interface VerifierResult {
  created: SessionInfo[];
  parentObserved: SessionInfo[];
  childObserved: SessionInfo[];
  updates: Array<{input: {sessionID: string; permissions?: unknown[]}}>;
  operations: string[];
  verdict: {state: string};
}
const providerRequests: ModelRequest[] = [];
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/chat/completions'))
      return new Response('not found', {status: 404});
    const body = (await request.json()) as ModelRequest;
    const taskId = JSON.stringify(body.messages).match(
      /task_id for this goal: ([A-Za-z0-9-]+)/,
    )?.[1];
    if (taskId) providerRequests.push(body);
    const hasToolReply = (body.messages ?? []).some(
      (message: unknown) => (message as {role?: unknown})?.role === 'tool',
    );
    const requestRead = Boolean(taskId) && !hasToolReply;
    const content = taskId
      ? JSON.stringify({
          schema_version: 1,
          task_id: taskId,
          state: 'COMPLETE',
          outstanding: [],
          evidence: ['Controlled response for verifier transport integration.'],
        })
      : 'Session title';
    const chunk = {
      id: `verifier-${providerRequests.length}`,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: body.model,
    };
    const chunks = [
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: requestRead
              ? {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_fixture_read',
                      type: 'function',
                      function: {
                        name: 'read',
                        arguments: JSON.stringify({
                          path: join(work, fixtureName),
                        }),
                      },
                    },
                  ],
                }
              : {role: 'assistant', content},
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: requestRead ? 'tool_calls' : 'stop',
          },
        ],
        usage: {prompt_tokens: 100, completion_tokens: 40, total_tokens: 140},
      },
    ];
    return new Response(
      chunks.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') +
        'data: [DONE]\n\n',
      {headers: {'Content-Type': 'text/event-stream; charset=utf-8'}},
    );
  },
});
writeFileSync(
  join(configDir, 'opencode.json'),
  JSON.stringify(
    {
      enabled_providers: ['mock'],
      provider: {
        mock: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Local verifier test provider',
          env: ['MOCK_API_KEY'],
          options: {baseURL: `http://127.0.0.1:${provider.port}/v1`},
          models: {
            'mock-model': {
              name: 'Mock Model',
              limit: {context: 131072, output: 8192},
            },
          },
        },
      },
      model: 'mock/mock-model',
      permissions: [
        {action: 'read', resource: '*' + fixtureName, effect: 'deny'},
      ],
      plugins: [
        {
          package: `file://${plugin}`,
          options: {
            idlePoller: false,
            childSessionJudge: false,
            logLevel: 'error',
          },
        },
      ],
    },
    null,
    2,
  ),
);
writeFileSync(join(root, 'models.json'), '{}');
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_MODELS_PATH: join(root, 'models.json'),
  PWD: work,
  MOCK_API_KEY: 'dummy',
  OPENCODE_PASSWORD: 'e2e',
  OPENCODE_SERVER_PASSWORD: 'e2e',
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_STATE_HOME: join(root, 'state'),
  XDG_CACHE_HOME: join(root, 'cache'),
  OPENCODE_CONFIG_DIR: configDir,
  OPENCODE_CONFIG: join(configDir, 'opencode.json'),
};
delete env.OPENCODE_CONFIG_CONTENT;
delete env.OPENCODE_TUI_CONFIG;
delete env.FIXATE_ON_STATE_ROOT;
const child = Bun.spawn(
  [
    binary,
    '--print-logs',
    '--log-level',
    'info',
    'serve',
    '--hostname',
    '127.0.0.1',
    '--port',
    '0',
  ],
  {cwd: work, env, stdout: 'pipe', stderr: 'pipe'},
);
let stdout = '';
let stderr = '';
let baseURL = '';
const stdoutTask = (async () => {
  for await (const chunk of child.stdout) {
    stdout += new TextDecoder().decode(chunk);
    baseURL = stdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
  }
})();
const stderrTask = (async () => {
  for await (const chunk of child.stderr)
    stderr += new TextDecoder().decode(chunk);
})();
const headers = {
  'Content-Type': 'application/json',
  Authorization: 'Basic ' + Buffer.from('opencode:e2e').toString('base64'),
  'x-opencode-directory': encodeURIComponent(work),
};
async function json(
  path: string,
  body?: unknown,
  method?: string,
): Promise<unknown> {
  const response = await fetch(baseURL + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.ok, `${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
function unwrap<T>(value: unknown): T {
  return (
    value && typeof value === 'object' && 'data' in value ? value.data : value
  ) as T;
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out: ${label}\n${stderr}`);
}

const results: Array<Record<string, unknown>> = [];
try {
  await until(() => Boolean(baseURL), 'host startup');
  await until(async () => {
    const agents = unwrap<Array<{id: string}>>(await json('/api/agent'));
    return agents.some(agent => agent.id === 'goal-verify');
  }, 'verifier agent registration');
  const readinessSession = unwrap<SessionInfo>(
    await json('/api/session', {title: 'Verifier policy readiness probe'}),
  );
  for (const phase of ['startup', 'reload'] as const) {
    if (phase === 'reload') {
      // A passive command receipt belongs to this plugin generation. Its cache
      // disappearing establishes that the changed options reloaded the plugin;
      // it does not claim that the host's later config transforms are ready.
      await json(`/api/session/${readinessSession.id}/command`, {
        name: 'goal',
        text: 'status',
      });
      const receipt = (await json('/api/rpc/fixate-on-output/latest', {
        input: {sessionID: readinessSession.id},
      })) as {output?: {id?: string} | null};
      assert.ok(
        receipt.output?.id,
        'The original plugin generation is observable',
      );
      const configPath = join(configDir, 'opencode.json');
      const config = JSON.parse(await Bun.file(configPath).text());
      config.plugins[0].options.verificationGeneration = 'reloaded';
      config.permissions.push({
        action: 'read',
        resource: '*reload-readiness-marker',
        effect: 'deny',
      });
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      await until(async () => {
        const response = await fetch(
          baseURL + '/api/rpc/fixate-on-output/latest',
          {
            method: 'POST',
            headers,
            body: JSON.stringify({input: {sessionID: readinessSession.id}}),
          },
        );
        if (!response.ok) return false; // The RPC can be absent during reload.
        const current = (await response.json()) as {output?: unknown};
        return current.output === null;
      }, 'plugin generation reload');
    }
    const beforeActivation = await json('/api/agent');
    writeFileSync(
      join(root, `observed-agents-${phase}-before-activation.json`),
      JSON.stringify(beforeActivation, null, 2),
    );
    // Agent inventory exposes registrations before the config plugin applies
    // global policy. On v2.2.7 the provider endpoint awaits Plugin.awaitActivation
    // for this same explicit location; catalog presence alone is not readiness.
    await json('/api/provider');
    const observedAgents = unwrap<Array<{id: string; permissions?: unknown[]}>>(
      await json('/api/agent'),
    );
    writeFileSync(
      join(root, 'observed-agents.json'),
      JSON.stringify(observedAgents, null, 2),
    );
    writeFileSync(
      join(root, `observed-agents-${phase}.json`),
      JSON.stringify(observedAgents, null, 2),
    );
    const verifierAgent = observedAgents.find(
      agent => agent.id === 'goal-verify',
    );
    assert.ok(
      verifierAgent?.permissions?.some((rule: unknown) => {
        const r = rule as {
          action?: unknown;
          resource?: unknown;
          effect?: unknown;
        };
        return (
          r.action === 'read' &&
          r.resource === '*' + fixtureName &&
          r.effect === 'deny'
        );
      }),
      'Configured deny is present on the actual verifier agent',
    );
    if (phase === 'reload') {
      assert.ok(
        verifierAgent?.permissions?.some(
          (rule: unknown) =>
            (rule as {resource?: unknown}).resource ===
            '*reload-readiness-marker',
        ),
        'The reloaded config policy is visible after activation',
      );
    }
    const cases = [
      {
        label: 'explicit-parent-allow',
        permissions: [{action: '*', resource: '*', effect: 'allow'}],
        expectedFixtureRead: true,
        initialAgents: [undefined] as const,
      },
      {
        label: 'global-config-deny-only',
        permissions: [],
        expectedFixtureRead: false,
        initialAgents: [undefined] as const,
      },
      {
        label: 'same-deny-also-on-parent-session',
        permissions: [
          {action: 'read', resource: '*' + fixtureName, effect: 'deny'},
        ],
        expectedFixtureRead: false,
        initialAgents: [undefined] as const,
      },
    ];
    for (const scenario of cases) {
      const parent = unwrap<SessionInfo>(
        await json('/api/session', {
          title: `Verifier integration parent (${scenario.label})`,
          agent: 'build',
          permissions: scenario.permissions,
        }),
      );
      assert.equal(parent.agent, 'build');
      // Native v2.2.7 children have no explicit agent until selected. The fixture
      // runs all create/switch/hook/prompt operations through the real Context.
      for (const initialAgent of scenario.initialAgents) {
        const providerStart = providerRequests.length;
        const response = (await json(`/api/rpc/${fixtureRPC}/verify`, {
          input: {parentID: parent.id, ...(initialAgent ? {initialAgent} : {})},
        })) as {output: VerifierResult};
        const {
          created,
          parentObserved,
          childObserved,
          updates,
          operations,
          verdict,
        } = response.output;
        assert.equal(verdict.state, 'COMPLETE');
        assert.equal(created.length, 1);
        assert.equal(created[0].agent, initialAgent);
        assert.equal(parentObserved.length, 2);
        const expectedPermissions = buildVerifierChildPermissions(
          parentObserved[1],
          parent.id,
          verifierAgent?.permissions,
        ).permissions;
        const deniedUntilAdmission = [
          {action: '*', resource: '*', effect: 'deny'},
        ];
        assert.deepEqual(created[0].permissions, deniedUntilAdmission);
        assert.equal(childObserved.length, 2);
        assert.deepEqual(childObserved[0].permissions, deniedUntilAdmission);
        assert.deepEqual(childObserved[1].permissions, expectedPermissions);
        assert.ok(childObserved.every(info => info.agent === 'goal-verify'));
        assert.ok(
          childObserved.every(info => info.location?.directory === work),
        );
        assert.equal(updates.length, 1);
        assert.equal(updates[0].input.sessionID, created[0].id);
        assert.deepEqual(updates[0].input.permissions, expectedPermissions);
        const admissionOrder = [
          'hook:prompt:register',
          'prompt:begin',
          'admission:start',
          'update',
          'admission:complete',
          'prompt:accepted',
          'hook:prompt:dispose',
          'wait',
          'context',
          'remove',
        ];
        for (const [index, operation] of admissionOrder.entries()) {
          assert.equal(
            operations.filter(observed => observed === operation).length,
            1,
            `Exactly one ${operation}`,
          );
          if (index > 0)
            assert.ok(
              operations.indexOf(admissionOrder[index - 1]) <
                operations.indexOf(operation),
              `Policy refresh and cleanup order: ${operations.join(', ')}`,
            );
        }
        const requests = providerRequests.slice(providerStart);
        assert.equal(requests.length, 2);
        const toolReply = (requests[1].messages ?? []).filter(
          (message: unknown) => (message as {role?: unknown})?.role === 'tool',
        );
        const fixtureWasRead =
          JSON.stringify(toolReply).includes(fixtureMarker);
        assert.equal(
          fixtureWasRead,
          scenario.expectedFixtureRead,
          'Measure the real host permission outcome',
        );
        const tools = (requests[0].tools ?? [])
          .map(tool => tool.function?.name ?? tool.name)
          .sort();
        assert.deepEqual(tools, ['glob', 'grep', 'read']);
        assert.equal(
          operations.filter(operation => operation === 'remove').length,
          1,
        );
        const after = await fetch(`${baseURL}/api/session/${created[0].id}`, {
          headers,
        });
        const deletionReceipt = await after.json();
        assert.equal(
          after.status,
          404,
          'The real host cannot retrieve the deleted child.',
        );
        const result = {
          hostVersion,
          runtime: Bun.version,
          phase,
          scenario: scenario.label,
          verifierAgent,
          fixtureWasRead,
          toolReply,
          initialAgent: initialAgent ?? 'host-default',
          parent,
          created,
          parentObserved,
          childObserved,
          updates,
          operations,
          verdict,
          tools,
          providerRequests: requests,
          deletionStatus: after.status,
          deletionReceipt,
        };
        results.push(result);
        writeFileSync(
          join(root, 'result.json'),
          JSON.stringify(results, null, 2),
        );
        console.log(
          JSON.stringify(
            {
              root,
              hostVersion,
              runtime: Bun.version,
              phase,
              scenario: scenario.label,
              state: verdict.state,
              fixtureWasRead,
              toolReply,
              initialAgent: created[0].agent ?? 'host-default',
              verifiedAgent: childObserved[0].agent,
              tools,
              modelRequests: requests.length,
              deletionStatus: after.status,
            },
            null,
            2,
          ),
        );
      }
    }
  }
} finally {
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await child.exited;
  clearTimeout(killTimer);
  await Promise.all([stdoutTask, stderrTask]);
  writeFileSync(join(root, 'host-stderr.log'), stderr);
  provider.stop(true);
}
