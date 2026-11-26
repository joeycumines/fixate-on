/**
 * Exercise the real v2.2.7 host with the child verifier and v2 client adapter.
 * OPENCODE_BINARY=/path/to/opencode bun hack/verify-child-session.ts
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
const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixate-child-session-')));
const work = join(root, 'work');
const plugin = join(root, 'plugin');
const configDir = join(root, 'config', 'opencode');
for (const directory of [work, plugin, configDir, join(root, 'home')])
  mkdirSync(directory, {recursive: true});
assert.equal(Bun.spawnSync(['git', 'init', '-q'], {cwd: work}).exitCode, 0);
const fixtureEntry = join(root, 'fixture.ts');
const source = resolve(import.meta.dir, '../src');
writeFileSync(
  fixtureEntry,
  `import GoalsPluginV2, {createV2ClientShim} from ${JSON.stringify(join(source, 'plugin-v2.ts'))};
import {createChildSessionVerifier} from ${JSON.stringify(join(source, 'child-session-verifier.ts'))};
import {createGoalState} from ${JSON.stringify(join(source, 'state-machine.ts'))};

const definition = {
  id: 'fixate-child-session-fixture',
  methods: {
    run: {
      input: {
        type: 'object',
        properties: {parentID: {type: 'string'}, initialAgent: {type: 'string'}},
        required: ['parentID'],
        additionalProperties: false,
      },
      output: {type: 'object', additionalProperties: true},
    },
  },
  events: {},
};

export default {
  ...GoalsPluginV2,
  async setup(ctx: any) {
    const dispose = await GoalsPluginV2.setup(ctx);
    const registration = await ctx.rpc.register(definition, {
      run: async ({parentID, initialAgent}: {parentID: string; initialAgent?: string}) => {
        const created: any[] = [];
        const parentObserved: any[] = [];
        const childObserved: any[] = [];
        const admissionObserved: any[] = [];
        const operations: string[] = [];
        // Delegate the real plugin Context. In particular, hook('prompt') runs
        // inside the host's admission boundary; an HTTP shim cannot model it.
        const session = new Proxy(ctx.session, {
          get(target, name) {
            const method = target[name];
            if (typeof method !== 'function') return method;
            if (name === 'create') return async (input: Record<string, unknown>) => {
              const info = await target.create({...input, ...(initialAgent ? {agent: initialAgent} : {})});
              created.push(JSON.parse(JSON.stringify(info)));
              operations.push('create:' + info.agent);
              return info;
            };
            if (name === 'get') return async (input: {sessionID: string}) => {
              const info = await target.get(input);
              (input.sessionID === parentID ? parentObserved : childObserved).push(JSON.parse(JSON.stringify(info)));
              operations.push('get:' + info.agent);
              return info;
            };
            if (name === 'switchAgent') return async (input: {agent: string}) => {
              const result = await target.switchAgent(input);
              operations.push('select:' + input.agent);
              return result;
            };
            if (name === 'update') return async (input: {sessionID: string}) => {
              const result = await target.update(input);
              admissionObserved.push(await target.get({sessionID: input.sessionID}));
              operations.push('update-policy');
              return result;
            };
            if (name === 'hook') return async (name: string, callback: (input: any) => Promise<void>) => {
              operations.push('hook:' + name);
              const registered = await target.hook(name, async (input: any) => {
                operations.push('hook:' + name + ':before');
                await callback(input);
                operations.push('hook:' + name + ':after');
              });
              return {dispose: async () => {
                await registered.dispose();
                operations.push('unhook:' + name);
              }};
            };
            if (name === 'prompt') return async (input: Record<string, unknown>) => {
              operations.push('prompt');
              const result = await target.prompt(input);
              operations.push('prompt:accepted');
              return result;
            };
            if (name === 'wait') return async (input: Record<string, unknown>) => {
              const result = await target.wait(input);
              operations.push('wait');
              return result;
            };
            if (name === 'context' || name === 'remove' || name === 'interrupt')
              return async (input: Record<string, unknown>) => {
                const result = await method.call(target, input);
                operations.push(String(name));
                return result;
              };
            return method.bind(target);
          },
        });
        const shim = createV2ClientShim({...ctx, session}, {bySession: new Map()});
        const goal = createGoalState(parentID, 'Exercise the verifier host transport', {
          goalId: 'live-verifier-goal', runId: 'live-verifier-run',
        });
        const verdict = await createChildSessionVerifier(shim, {timeoutMs: 15_000})({
          goal, taskId: goal.goalId, cwd: ctx.location.directory,
          latestText: 'Controlled completion claim',
          candidateIdentity: {candidate: 'integration', fingerprint: 'integration'},
        });
        return JSON.parse(JSON.stringify({created, parentObserved, childObserved, admissionObserved, operations, verdict}));
      },
    });
    return async () => {await registration.dispose(); await dispose();};
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
interface FixtureResult {
  created: SessionInfo[];
  parentObserved: SessionInfo[];
  childObserved: SessionInfo[];
  admissionObserved: SessionInfo[];
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
            delta: {role: 'assistant', content},
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
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
  HOME: join(root, 'home'),
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_AUTOUPDATE: 'true',
  OPENCODE_DISABLE_CLAUDE_CODE: 'true',
  OPENCODE_CONFIG_PROJECT_DISABLE: 'true',
  OPENCODE_DISABLE_FILEWATCHER: 'true',
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
  const verifierAgent = unwrap<Array<{id: string; permissions?: unknown[]}>>(
    await json('/api/agent'),
  ).find(agent => agent.id === 'goal-verify');
  const cases = [
    {
      label: 'allow-all-parent',
      permissions: [{action: '*', resource: '*', effect: 'allow'}],
      initialAgents: [undefined, 'build'] as const,
    },
    {
      label: 'restrictive-parent',
      permissions: [{action: 'read', resource: '*secrets.pem', effect: 'deny'}],
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
    // Native v2.2.7 children have no explicit agent until selected. Also exercise
    // a child explicitly initialized as build, representing a host/default that
    // supplies that field. Both use the actual host's create/switch/prompt APIs.
    for (const initialAgent of scenario.initialAgents) {
      const providerStart = providerRequests.length;
      const response = (await json(
        '/api/rpc/fixate-child-session-fixture/run',
        {
          input: {parentID: parent.id, ...(initialAgent ? {initialAgent} : {})},
        },
      )) as {output: FixtureResult};
      const {
        created,
        parentObserved,
        childObserved,
        admissionObserved,
        operations,
        verdict,
      } = response.output;
      assert.equal(verdict.state, 'COMPLETE');
      assert.equal(created.length, 1);
      assert.equal(created[0].agent, initialAgent);
      assert.equal(
        parentObserved.length,
        2,
        'Parent policy is refreshed at admission.',
      );
      const expectedPermissions = buildVerifierChildPermissions(
        parentObserved[1],
        parent.id,
        verifierAgent?.permissions,
      ).permissions;
      const inertPermissions = [{action: '*', resource: '*', effect: 'deny'}];
      assert.deepEqual(created[0].permissions, inertPermissions);
      assert.equal(admissionObserved.length, 1);
      assert.deepEqual(admissionObserved[0].permissions, expectedPermissions);
      assert.equal(admissionObserved[0].agent, 'goal-verify');
      assert.equal(
        operations.filter(operation => operation === 'hook:prompt:before')
          .length,
        1,
      );
      assert.equal(
        operations.filter(operation => operation === 'unhook:prompt').length,
        1,
      );
      assert.ok(
        operations.indexOf('prompt') < operations.indexOf('update-policy'),
      );
      assert.ok(
        operations.indexOf('hook:prompt:before') <
          operations.indexOf('update-policy'),
      );
      assert.ok(
        operations.indexOf('update-policy') <
          operations.indexOf('hook:prompt:after'),
      );
      assert.ok(
        operations.indexOf('hook:prompt:after') <
          operations.indexOf('prompt:accepted'),
      );
      assert.equal(childObserved.length, 3);
      assert.ok(childObserved.every(info => info.agent === 'goal-verify'));
      assert.ok(childObserved.every(info => info.location?.directory === work));
      assert.deepEqual(childObserved[0].permissions, inertPermissions);
      for (const settled of childObserved.slice(1))
        assert.deepEqual(settled.permissions, expectedPermissions);
      const requests = providerRequests.slice(providerStart);
      assert.equal(requests.length, 1);
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
        scenario: scenario.label,
        initialAgent: initialAgent ?? 'host-default',
        parent,
        created,
        parentObserved,
        childObserved,
        admissionObserved,
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
            scenario: scenario.label,
            state: verdict.state,
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
} finally {
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await child.exited;
  clearTimeout(killTimer);
  await Promise.all([stdoutTask, stderrTask]);
  writeFileSync(join(root, 'host-stderr.log'), stderr);
  provider.stop(true);
}
