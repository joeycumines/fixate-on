/**
 * Exercise the real v2.2.7 host with the child verifier and v2 client adapter.
 * OPENCODE_BINARY=/path/to/opencode bun hack/verify-verifier-context.ts
 * The model provider is controlled. Cases cover successful final replies, failed
 * context reads, output-limit exhaustion, next-step preparation failure, and an
 * idle-hook failure after a complete-looking final response.
 * The fixture RPC executes the verifier inside the real plugin context, including
 * its prompt admission hook and permission update. Session persistence, tools,
 * context hook snapshots and final messages run through an isolated official host.
 * Logs and JSON evidence stay in /tmp.
 */
import {strict as assert} from 'node:assert';
import {mkdirSync, mkdtempSync, realpathSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {buildVerifierChildPermissions} from '../src/plugin-v2-tools-agents.ts';
import {
  findLatestAssistantMessage,
  getTextFromParts,
} from '../src/message-helpers.ts';
import {normalizeV2Messages} from '../src/plugin-v2-helpers.ts';

const binary = process.env.OPENCODE_BINARY ?? 'opencode';
const version = Bun.spawnSync([binary, '--version']);
assert.equal(version.exitCode, 0);
const hostVersion = version.stdout.toString().trim();
assert.match(hostVersion, /\bv?2\./, 'Expected an OpenCode v2 binary.');
const root = realpathSync(
  mkdtempSync(join(tmpdir(), 'fixate-verifier-settlement-')),
);
const work = join(root, 'work');
const plugin = join(root, 'plugin');
const configDir = join(root, 'config', 'opencode');
for (const directory of [work, plugin, configDir])
  mkdirSync(directory, {recursive: true});
assert.equal(Bun.spawnSync(['git', 'init', '-q'], {cwd: work}).exitCode, 0);
const fixtureName = 'review-fixture.txt';
const fixtureMarker = 'Controlled unfinished review fixture.';
writeFileSync(join(work, fixtureName), fixtureMarker + '\n');
const captures = join(root, 'context-captures');
mkdirSync(captures);
const entry = join(root, 'observer-plugin.ts');
writeFileSync(
  entry,
  `
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setup, createV2ClientShim} from ${JSON.stringify(resolve(import.meta.dir, '../src/plugin-v2.ts'))};
import {createChildSessionVerifier} from ${JSON.stringify(resolve(import.meta.dir, '../src/child-session-verifier.ts'))};
import {createGoalState} from ${JSON.stringify(resolve(import.meta.dir, '../src/state-machine.ts'))};
import {unwrapV2Data} from ${JSON.stringify(resolve(import.meta.dir, '../src/plugin-v2-helpers.ts'))};
export default {id: 'fixate-on', async setup(ctx) {
  const dispose = await setup(ctx);
  const snapshots = new Map();
  const modes = new Map();
  const observer = await ctx.session.hook('context', input => {
    if (modes.get(input.sessionID) === 'preparation-failure' && snapshots.has(input.sessionID))
      throw new Error('Controlled next-step preparation failure after interim verdict');
    const snapshot = JSON.parse(JSON.stringify(input.messages));
    snapshots.set(input.sessionID, snapshot);
    writeFileSync(join(${JSON.stringify(captures)}, input.sessionID + '.json'), JSON.stringify(snapshot));
  });
  const idleObserver = await ctx.session.hook('experimental.idle', input => {
    if (modes.get(input.sessionID) === 'idle-failure')
      throw new Error('Controlled idle-hook failure after final verdict');
  });
  const rpc = await ctx.rpc.register({
    id: 'fixate-verifier-context-fixture',
    methods: {verify: {
      input: {type: 'object', properties: {parentID: {type: 'string'}, mode: {type: 'string', enum: ['working', 'complete', 'read-failure', 'output-limit', 'preparation-failure', 'idle-failure']}}, required: ['parentID', 'mode'], additionalProperties: false},
      output: {type: 'object', additionalProperties: true},
    }},
    events: {},
  }, {verify: async ({parentID, mode}) => {
    const created = [];
    const parentObserved = [];
    const childObserved = [];
    const permissionUpdates = [];
    const operations = [];
    const buffer = {bySession: new Map()};
    let actualContext = [];
    let settled = null;
    const session = {...ctx.session,
      create: async input => {
        const info = unwrapV2Data(await ctx.session.create(input));
        modes.set(info.id, mode);
        created.push(JSON.parse(JSON.stringify(info)));
        operations.push('create:' + info.agent);
        return info;
      },
      get: async input => {
        const info = unwrapV2Data(await ctx.session.get(input));
        (input.sessionID === parentID ? parentObserved : childObserved).push(JSON.parse(JSON.stringify(info)));
        operations.push('get:' + info.agent);
        return info;
      },
      switchAgent: async input => {
        const result = await ctx.session.switchAgent(input);
        operations.push('select:' + input.agent);
        return result;
      },
      hook: async (name, callback) => {
        operations.push('hook:' + name);
        const registration = await ctx.session.hook(name, async input => {
          if (name === 'prompt') operations.push('admission:' + input.sessionID);
          await callback(input);
        });
        return {dispose: async () => {
          await registration.dispose();
          operations.push('dispose:' + name);
        }};
      },
      update: async input => {
        const result = await ctx.session.update(input);
        permissionUpdates.push(unwrapV2Data(await ctx.session.get({sessionID: input.sessionID})));
        operations.push('update');
        return result;
      },
      prompt: async input => {
        operations.push('prompt');
        return ctx.session.prompt(input);
      },
      wait: async input => {
        const result = await ctx.session.wait(input);
        operations.push('wait');
        const snapshot = snapshots.get(input.sessionID);
        if (!Array.isArray(snapshot)) throw new Error('The real context hook did not capture the verifier turn.');
        buffer.bySession.set(input.sessionID, snapshot);
        actualContext = unwrapV2Data(await ctx.session.context(input));
        settled = unwrapV2Data(await ctx.session.get(input));
        return result;
      },
      context: async input => {
        operations.push('context');
        if (mode === 'read-failure') throw new Error('Injected transient post-turn context read failure');
        return ctx.session.context(input);
      },
      remove: async input => {
        const result = await ctx.session.remove(input);
        operations.push('remove');
        return result;
      },
      interrupt: async input => {
        operations.push('interrupt');
        return ctx.session.interrupt(input);
      },
    };
    const shim = createV2ClientShim({...ctx, session}, buffer);
    const goal = createGoalState(parentID, 'Exercise the verifier host transport', {
      goalId: 'live-verifier-' + mode, runId: 'live-verifier-run',
    });
    let verdict = null;
    let fault = null;
    try {
      verdict = await createChildSessionVerifier(shim, {timeoutMs: 15_000})({
        goal, taskId: goal.goalId, cwd: ${JSON.stringify(work)},
        latestText: 'Controlled completion claim',
        candidateIdentity: {candidate: 'integration', fingerprint: 'integration'},
      });
    } catch (error) {
      fault = error instanceof Error ? error.message : String(error);
    }
    return JSON.parse(JSON.stringify({created, parentObserved, childObserved, permissionUpdates, operations, verdict, fault,
      actualContext, settled, bufferedContext: buffer.bySession.get(created[0]?.id) ?? [],
      verifierAgent: unwrapV2Data(await ctx.agent.get({agentID: 'goal-verify'})),
    }));
  }});
  return async () => {await rpc.dispose(); await idleObserver.dispose(); await observer.dispose(); await dispose();};
}};
`,
);
const built = await Bun.build({
  entrypoints: [entry],
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
  outcome?: string;
}
interface FixtureResult {
  created: SessionInfo[];
  parentObserved: SessionInfo[];
  childObserved: SessionInfo[];
  permissionUpdates: SessionInfo[];
  operations: string[];
  verdict: {state: string} | null;
  fault: string | null;
  actualContext: unknown[];
  settled: SessionInfo;
  bufferedContext: unknown[];
  verifierAgent: {id: string; permissions?: unknown[]};
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
    const mode = taskId?.replace('live-verifier-', '');
    if (taskId) providerRequests.push(body);
    const hasToolReply = (body.messages ?? []).some(
      (message: unknown) => (message as {role?: unknown})?.role === 'tool',
    );
    const outputLimit = mode === 'output-limit';
    const requestRead = Boolean(taskId) && !hasToolReply && !outputLimit;
    const finalComplete = mode === 'complete' || mode === 'idle-failure';
    const content = taskId
      ? JSON.stringify({
          schema_version: 1,
          task_id: taskId,
          state: hasToolReply && !finalComplete ? 'WORKING' : 'COMPLETE',
          outstanding:
            hasToolReply && !finalComplete
              ? ['The fixture is unfinished.']
              : [],
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
                  content,
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
            finish_reason: outputLimit
              ? 'length'
              : requestRead
                ? 'tool_calls'
                : 'stop',
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
      permissions: [],
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
  // This ordinary API read completes host activation before observing agents.
  await json('/api/provider');
  await until(async () => {
    const agents = unwrap<Array<{id: string}>>(await json('/api/agent'));
    return agents.some(agent => agent.id === 'goal-verify');
  }, 'verifier agent registration');
  const cases = [
    {
      mode: 'working',
      finalState: 'WORKING',
      expectedState: 'WORKING',
      requests: 2,
    },
    {
      mode: 'complete',
      finalState: 'COMPLETE',
      expectedState: 'COMPLETE',
      requests: 2,
    },
    {
      mode: 'read-failure',
      finalState: 'WORKING',
      fault: /Injected transient post-turn context read failure/,
      requests: 2,
    },
    {
      mode: 'output-limit',
      finalState: 'COMPLETE',
      fault: /Child execution failed:.*output token limit/,
      requests: 3,
    },
    {
      mode: 'preparation-failure',
      finalState: 'COMPLETE',
      fault:
        /Child execution failed:.*Controlled next-step preparation failure/,
      requests: 1,
    },
    {
      mode: 'idle-failure',
      finalState: 'COMPLETE',
      fault: /Child execution failed:.*Controlled idle-hook failure/,
      requests: 2,
    },
  ];
  for (const scenario of cases) {
    const parent = unwrap<SessionInfo>(
      await json('/api/session', {
        title: `Verifier integration parent (${scenario.mode})`,
        agent: 'build',
        permissions: [],
      }),
    );
    assert.equal(parent.agent, 'build');
    const providerStart = providerRequests.length;
    const {output} = (await json(
      '/api/rpc/fixate-verifier-context-fixture/verify',
      {input: {parentID: parent.id, mode: scenario.mode}},
    )) as {output: FixtureResult};
    const {
      created,
      parentObserved,
      childObserved,
      permissionUpdates,
      operations,
      verdict,
      fault,
      actualContext,
      settled,
      bufferedContext,
      verifierAgent,
    } = output;
    // Persist the raw observation even if an assertion fails, so regressions
    // remain diagnosable from the same host run.
    writeFileSync(
      join(root, `${scenario.mode}.json`),
      JSON.stringify(output, null, 2),
    );
    if (scenario.fault) {
      assert.equal(
        verdict,
        null,
        'A fault obtaining the final result must never return an attestation.',
      );
      assert.match(fault ?? '', scenario.fault);
    } else {
      assert.equal(verdict?.state, scenario.expectedState, fault ?? undefined);
    }
    assert.equal(
      settled.outcome,
      ['output-limit', 'preparation-failure', 'idle-failure'].includes(
        scenario.mode,
      )
        ? 'failed'
        : 'succeeded',
      'Measure execution success independently of the verifier response.',
    );
    const actualLast = findLatestAssistantMessage(
      normalizeV2Messages(actualContext as unknown[]),
    ) as {parts: unknown[]} | null;
    const bufferedLast = findLatestAssistantMessage(
      normalizeV2Messages(bufferedContext),
    ) as {parts: unknown[]};
    assert.ok(actualLast, 'The real host retained the assistant response.');
    const actualFinalText = getTextFromParts(actualLast.parts);
    const bufferedFinalText = getTextFromParts(bufferedLast?.parts);
    assert.equal(JSON.parse(actualFinalText).state, scenario.finalState);
    if (bufferedFinalText)
      assert.equal(JSON.parse(bufferedFinalText).state, 'COMPLETE');
    assert.equal(created.length, 1);
    assert.equal(created[0].agent, undefined);
    assert.equal(parentObserved.length, 2);
    const expectedPermissions = buildVerifierChildPermissions(
      parentObserved[0],
      parent.id,
      verifierAgent?.permissions,
    ).permissions;
    assert.deepEqual(created[0].permissions, [
      {action: '*', resource: '*', effect: 'deny'},
    ]);
    assert.equal(permissionUpdates.length, 1);
    assert.deepEqual(permissionUpdates[0].permissions, expectedPermissions);
    assert.ok(operations.includes('hook:prompt'));
    assert.ok(operations.includes('admission:' + created[0].id));
    assert.ok(
      operations.indexOf('admission:' + created[0].id) <
        operations.indexOf('update'),
    );
    assert.ok(operations.indexOf('update') < operations.indexOf('wait'));
    assert.ok(operations.includes('dispose:prompt'));
    assert.ok(childObserved.length >= 1);
    assert.ok(childObserved.every(info => info.agent === 'goal-verify'));
    assert.ok(childObserved.every(info => info.location?.directory === work));
    const requests = providerRequests.slice(providerStart);
    assert.equal(requests.length, scenario.requests);
    const toolReply = (requests[1]?.messages ?? []).filter(
      (message: unknown) => (message as {role?: unknown})?.role === 'tool',
    );
    const fixtureWasRead = JSON.stringify(toolReply).includes(fixtureMarker);
    assert.equal(
      fixtureWasRead,
      !['output-limit', 'preparation-failure'].includes(scenario.mode),
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
      scenario: scenario.mode,
      verifierAgent,
      settled,
      actualFinalText,
      bufferedFinalText,
      actualContext,
      buffer: bufferedContext,
      fixtureWasRead,
      toolReply,
      initialAgent: 'host-default',
      parent,
      created,
      parentObserved,
      childObserved,
      permissionUpdates,
      operations,
      verdict,
      fault,
      tools,
      providerRequests: requests,
      deletionStatus: after.status,
      deletionReceipt,
    };
    results.push(result);
    writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
    console.log(
      JSON.stringify(
        {
          root,
          hostVersion,
          runtime: Bun.version,
          scenario: scenario.mode,
          state: verdict?.state ?? 'FAULT',
          fault,
          actualFinalState: JSON.parse(actualFinalText).state,
          bufferedFinalState: bufferedFinalText
            ? JSON.parse(bufferedFinalText).state
            : null,
          executionOutcome: settled.outcome,
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
} finally {
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await child.exited;
  clearTimeout(killTimer);
  await Promise.all([stdoutTask, stderrTask]);
  writeFileSync(join(root, 'host-stderr.log'), stderr);
  provider.stop(true);
}
