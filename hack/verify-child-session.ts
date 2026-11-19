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
import {createChildSessionVerifier} from '../src/child-session-verifier.ts';
import {createV2ClientShim} from '../src/plugin-v2.ts';
import {buildVerifierChildPermissions} from '../src/plugin-v2-tools-agents.ts';
import {createGoalState} from '../src/state-machine.ts';

const binary = process.env.OPENCODE_BINARY ?? 'opencode';
const version = Bun.spawnSync([binary, '--version']);
assert.equal(version.exitCode, 0);
const hostVersion = version.stdout.toString().trim();
assert.match(hostVersion, /\bv?2\./, 'Expected an OpenCode v2 binary.');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'fixate-child-session-')));
const work = join(root, 'work');
const plugin = join(root, 'plugin');
const configDir = join(root, 'config', 'opencode');
for (const directory of [work, plugin, configDir])
  mkdirSync(directory, {recursive: true});
assert.equal(Bun.spawnSync(['git', 'init', '-q'], {cwd: work}).exitCode, 0);
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, '../src/plugin-v2.ts')],
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
const env: NodeJS.ProcessEnv = {
  ...process.env,
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
      const created: SessionInfo[] = [];
      const parentObserved: SessionInfo[] = [];
      const childObserved: SessionInfo[] = [];
      const operations: string[] = [];
      const providerStart = providerRequests.length;
      const shim = createV2ClientShim(
        {
          location: {directory: work},
          session: {
            create: async (input: Record<string, unknown>) => {
              const info = unwrap<SessionInfo>(
                await json('/api/session', {
                  ...input,
                  ...(initialAgent ? {agent: initialAgent} : {}),
                }),
              );
              created.push(info);
              operations.push(`create:${info.agent}`);
              return info;
            },
            get: async ({sessionID}: {sessionID: string}) => {
              const info = unwrap<SessionInfo>(
                await json(`/api/session/${sessionID}`),
              );
              if (sessionID === parent.id) parentObserved.push(info);
              else childObserved.push(info);
              operations.push(`get:${info.agent}`);
              return info;
            },
            switchAgent: async ({
              sessionID,
              agent,
            }: {
              sessionID: string;
              agent: string;
            }) => {
              await json(`/api/session/${sessionID}/agent`, {agent});
              operations.push(`select:${agent}`);
            },
            prompt: async ({
              sessionID,
              text,
            }: {
              sessionID: string;
              text: string;
            }) => {
              operations.push('prompt');
              return json(`/api/session/${sessionID}/prompt`, {text});
            },
            wait: async ({sessionID}: {sessionID: string}) => {
              await json(`/api/experimental/session/${sessionID}/wait`, {});
              operations.push('wait');
            },
            context: async ({sessionID}: {sessionID: string}) => {
              operations.push('context');
              return json(`/api/session/${sessionID}/context`);
            },
            remove: async ({sessionID}: {sessionID: string}) => {
              await json(`/api/session/${sessionID}`, undefined, 'DELETE');
              operations.push('remove');
            },
            interrupt: async ({sessionID}: {sessionID: string}) => {
              operations.push('interrupt');
              return json(`/api/session/${sessionID}/interrupt`, {});
            },
          },
        } as never,
        {bySession: new Map()},
      );
      const goal = createGoalState(
        parent.id,
        'Exercise the verifier host transport',
        {
          goalId: 'live-verifier-goal',
          runId: 'live-verifier-run',
        },
      );
      const verdict = await createChildSessionVerifier(shim, {
        timeoutMs: 15_000,
      })({
        goal,
        taskId: goal.goalId,
        cwd: work,
        latestText: 'Controlled completion claim',
        candidateIdentity: {
          candidate: 'integration',
          fingerprint: 'integration',
        },
      });
      assert.equal(verdict.state, 'COMPLETE');
      assert.equal(created.length, 1);
      assert.equal(created[0].agent, initialAgent);
      assert.equal(parentObserved.length, 1);
      const expectedPermissions = buildVerifierChildPermissions(
        parentObserved[0],
        parent.id,
      ).permissions;
      assert.deepEqual(created[0].permissions, expectedPermissions);
      assert.equal(childObserved.length, 2);
      assert.ok(childObserved.every(info => info.agent === 'goal-verify'));
      assert.ok(childObserved.every(info => info.location?.directory === work));
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
