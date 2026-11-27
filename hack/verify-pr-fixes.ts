/**
 * Real OpenCode 2.2.7 checks against a local deterministic provider.
 * OPENCODE_BINARY=/path/to/opencode bun hack/verify-pr-fixes.ts
 * The process, git workspace, config, provider, and state are all isolated.
 * FIXATE_ON_SOURCE_ROOT can select another checkout for before/after validation.
 */
import {strict as assert} from 'node:assert';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {GOAL_OUTPUT_RPC} from '../src/plugin-v2-command-output.ts';
import {wireGoalCommandOutput} from '../src/tui-v2-command-output.ts';

const binary = process.env.OPENCODE_BINARY ?? 'opencode';
const root = mkdtempSync(join(tmpdir(), 'fixate-pr-fixes-'));
const work = join(root, 'work');
const plugin = join(root, 'plugin');
const configDir = join(root, 'config', 'opencode');
for (const directory of [work, plugin, configDir, join(root, 'home')])
  mkdirSync(directory, {recursive: true});
assert.equal(Bun.spawnSync(['git', 'init', '-q'], {cwd: work}).exitCode, 0);
const source =
  process.env.FIXATE_ON_SOURCE_ROOT ?? resolve(import.meta.dir, '../src');
const fixtureEntry = join(root, 'fixture.ts');
// This observer runs after the plugin's prompt admission hook. Holding a real
// host hook provides a deterministic asynchronous preparation boundary while
// the host still materializes a valid regular-file attachment on release.
writeFileSync(
  fixtureEntry,
  `
import GoalsPluginV2 from ${JSON.stringify(join(source, 'plugin-v2.ts'))};
export default {...GoalsPluginV2, async setup(ctx) {
  const dispose = await GoalsPluginV2.setup(ctx);
  const gates = new Map();
  const observer = await ctx.session.hook('prompt', async input => {
    const gate = gates.get(input.sessionID)?.find(gate => !gate.entered);
    if (!gate) return;
    gate.entered = true;
    await gate.promise;
  });
  const input = {type:'object',properties:{sessionID:{type:'string'}},required:['sessionID'],additionalProperties:false};
  const output = {type:'object',additionalProperties:true};
  const rpc = await ctx.rpc.register({
    id:'fixate-admission-fixture',
    methods:{arm:{input,output},state:{input,output},release:{input,output}},
    events:{},
  }, {
    arm: async ({sessionID}) => {
      let release;
      const promise = new Promise(resolve => {release = resolve;});
      const queue = gates.get(sessionID) ?? [];
      queue.push({entered:false,released:false,promise,release});
      gates.set(sessionID,queue);
      return {armed:true};
    },
    state: async ({sessionID}) => ({entered:gates.get(sessionID)?.at(-1)?.entered ?? false}),
    release: async ({sessionID}) => {
      const gate = gates.get(sessionID)?.find(gate => !gate.released);
      if (gate) {gate.released = true; gate.release();}
      return {released:true};
    },
  });
  return async () => {
    for (const queue of gates.values()) for (const gate of queue) gate.release();
    await observer.dispose(); await rpc.dispose(); await dispose();
  };
}};
`,
);
const built = await Bun.build({
  entrypoints: [fixtureEntry],
  target: 'bun',
  outdir: plugin,
  naming: 'server.js',
});
assert.ok(built.success, String(built.logs));
const version = Bun.spawnSync([binary, '--version']);
assert.equal(version.exitCode, 0);
const hostVersion = version.stdout.toString().trim();
assert.match(hostVersion, /\bv?2\./, 'Expected an OpenCode v2 binary.');

type RequestBody = {messages?: unknown[]; model?: string; stream?: boolean};
const providerRequests: RequestBody[] = [];
let releaseHeld = () => {};
let held = false;
const provider = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/chat/completions'))
      return new Response('not found', {status: 404});
    const body = (await request.json()) as RequestBody;
    providerRequests.push(body);
    const lastMessage = JSON.stringify(body.messages?.at(-1));
    const summaryRequest =
      lastMessage?.includes('## Objective') &&
      lastMessage.includes('## Work State');
    // The host rejects arbitrary prose as a compaction summary. A completed
    // checkpoint, not merely an attempted request, is the positive control.
    const responseText = summaryRequest
      ? '## Objective\nContinue the admitted request.\n## Work State\n### Completed\nThe prior admitted turn returned a controlled response.\n## Next Move\nFollow the next genuine user instruction.'
      : 'Controlled response.';
    if (JSON.stringify(body.messages).includes('HOLD_OUTPUT_TEST') && !held) {
      held = true;
      await new Promise<void>(resolve => {
        releaseHeld = resolve;
      });
    }
    if (!body.stream) {
      return Response.json({
        id: `probe-${providerRequests.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: {role: 'assistant', content: responseText},
            finish_reason: 'stop',
          },
        ],
        usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16},
      });
    }
    const chunk = {
      id: `probe-${providerRequests.length}`,
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
            delta: {role: 'assistant', content: responseText},
            finish_reason: null,
          },
        ],
      },
      {
        ...chunk,
        choices: [{index: 0, delta: {}, finish_reason: 'stop'}],
        usage: {prompt_tokens: 12, completion_tokens: 4, total_tokens: 16},
      },
    ];
    return new Response(
      chunks.map(item => `data: ${JSON.stringify(item)}\n\n`).join('') +
        'data: [DONE]\n\n',
      {
        headers: {'Content-Type': 'text/event-stream; charset=utf-8'},
      },
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
          name: 'Local test provider',
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
            noToolCallTurnsBeforePause: 1,
            minDelayMs: 0,
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
let stdout = '';
let stderr = '';
let baseURL = '';
function bootHost() {
  baseURL = '';
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
    {
      cwd: work,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let processStdout = '';
  const stdoutTask = (async () => {
    for await (const chunk of child.stdout) {
      const text = new TextDecoder().decode(chunk);
      stdout += text;
      processStdout += text;
      baseURL = processStdout.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0] ?? '';
    }
  })();
  const stderrTask = (async () => {
    for await (const chunk of child.stderr)
      stderr += new TextDecoder().decode(chunk);
  })();
  return {
    async stop() {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await child.exited;
      clearTimeout(killTimer);
      await Promise.all([stdoutTask, stderrTask]);
    },
  };
}
let host = bootHost();
const headers = {
  'Content-Type': 'application/json',
  Authorization: 'Basic ' + Buffer.from('opencode:e2e').toString('base64'),
};
async function json(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(baseURL + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
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
const controller = new AbortController();
let eventTask = Promise.resolve();
let receive: (event: {data: unknown}) => void = () => {};
let activeSession = '';
const displayed: string[] = [];
const events: Array<{type: string; data: Record<string, unknown>}> = [];
const disposeOutput = wireGoalCommandOutput(
  {
    client: {},
    data: {
      on: (type, handler) => {
        if (type === 'rpc.fixate-on-output.output') receive = handler;
        return () => {};
      },
    },
    ui: {
      router: {current: () => ({type: 'session', sessionID: activeSession})},
      toast: {show: () => {}},
    },
  },
  text => displayed.push(text),
);
const results: Record<string, unknown> = {
  hostVersion,
  runtime: Bun.version,
  passed: false,
};
try {
  await until(() => Boolean(baseURL), 'host startup');
  const session = unwrap<{id: string}>(
    await json('/api/session', {title: 'Passive output verification'}),
  );
  activeSession = session.id;
  const sid = session.id;
  assert.ok(sid);
  await until(async () => {
    const commands = unwrap<Array<{name: string; description?: string}>>(
      await json('/api/command'),
    );
    return commands.some(
      command =>
        command.name === 'goal' &&
        command.description?.includes('persistent thread goal'),
    );
  }, 'plugin registration');
  const response = await fetch(baseURL + '/api/event', {
    headers,
    signal: controller.signal,
  });
  assert.ok(response.ok && response.body);
  eventTask = (async () => {
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body!) {
      pending += decoder.decode(chunk, {stream: true});
      let boundary: number;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as {
          type: string;
          data: Record<string, unknown>;
        };
        events.push(event);
        if (event.type === `rpc.${GOAL_OUTPUT_RPC.id}.output`) receive(event);
      }
    }
  })().catch(error => {
    if (!controller.signal.aborted) throw error;
  });
  await until(
    () => events.some(event => event.type === 'server.connected'),
    'event connection',
  );
  const command = (text: string, files?: unknown[]) =>
    json(`/api/session/${sid}/command`, {
      name: 'goal',
      text,
      ...(files ? {files} : {}),
    });
  const latest = async () =>
    (await json(`/api/rpc/${GOAL_OUTPUT_RPC.id}/latest`, {
      input: {sessionID: sid},
    })) as {output: {text: string}};
  const wait = () => json(`/api/experimental/session/${sid}/wait`, {});
  const inbox = async () =>
    unwrap<unknown[]>(await json(`/api/session/${sid}/inbox`));

  await command('status');
  await until(() => displayed.length === 1, 'full passive status receipt');
  assert.match(displayed[0], /No active goal/i);
  assert.equal((await latest()).output.text, displayed[0]);
  assert.deepEqual(await inbox(), []);
  assert.equal(providerRequests.length, 0);
  results.idleStatus = {
    providerRequests: 0,
    inbox: 0,
    displayedText: displayed[0],
  };

  await json(`/api/session/${sid}/prompt`, {text: 'HOLD_OUTPUT_TEST'});
  await until(() => held, 'in-flight provider request');
  const beforeBusy = providerRequests.length;
  await command('status');
  await until(() => displayed.length === 2, 'busy status receipt');
  assert.deepEqual(await inbox(), []);
  releaseHeld();
  await wait();
  assert.equal(providerRequests.length, beforeBusy);
  assert.equal(
    JSON.stringify(providerRequests).includes('No active goal'),
    false,
  );
  results.busyStatus = {
    providerRequestsBefore: beforeBusy,
    providerRequestsAfter: providerRequests.length,
    inbox: 0,
  };

  await command('Preserve the attachment requirements');
  const statePath = join(
    work,
    '.opencode',
    'goals',
    'sessions',
    sid,
    'state.json',
  );
  const readState = () =>
    JSON.parse(readFileSync(statePath, 'utf8')) as {
      goals: Array<{goalId: string; condition: string; status: string}>;
    };
  await until(() => {
    try {
      return readState().goals[0]?.status === 'paused';
    } catch {
      return false;
    }
  }, 'goal pause at tool-free-turn bound');
  await wait();
  const original = readState().goals[0];
  const attachment = join(work, 'requirements.txt');
  writeFileSync(
    attachment,
    'ATTACHMENT_REACHED_MODEL: preserve these requirements.',
  );
  const files = [{uri: `file://${attachment}`, name: 'requirements.txt'}];
  const rejected = await fetch(baseURL + `/api/session/${sid}/command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'goal',
      text: `clear ${original.goalId}`,
      files,
    }),
  });
  assert.equal(rejected.ok, false);
  assert.equal(readState().goals[0].goalId, original.goalId);
  const multiline = `clear\n${original.goalId}`;
  await command(multiline, files);
  const replaced = readState().goals[0];
  assert.equal(readState().goals.length, 1);
  assert.equal(replaced.condition, multiline.replace(/\s+/g, ' '));
  await until(
    () => JSON.stringify(providerRequests).includes('ATTACHMENT_REACHED_MODEL'),
    'attachment in accepted multiline objective',
  );
  await wait();
  results.attachedClear = {
    rejectedClearPreservedGoal: true,
    acceptedMultilineObjective: replaced.condition,
    goalCount: 1,
    attachmentDelivered: true,
  };
  const rpc = async (method: string, sessionID: string) =>
    (await json(`/api/rpc/fixate-admission-fixture/${method}`, {
      input: {sessionID},
    })) as {output: {entered?: boolean}};
  const waitSession = (sessionID: string) =>
    json(`/api/experimental/session/${sessionID}/wait`, {});
  const confirmedFork = unwrap<{id: string}>(
    await json(`/api/session/${sid}/fork`, {}),
  );
  const confirmedStart: number = providerRequests.length;
  await json(`/api/session/${confirmedFork.id}/prompt`, {
    text: 'GENUINE_AFTER_CONFIRMED_FORK',
  });
  await waitSession(confirmedFork.id);
  assert.ok(
    JSON.stringify(providerRequests.slice(confirmedStart)).includes(
      'ATTACHMENT_REACHED_MODEL',
    ),
    'Confirmed historical attachments must remain available after a fork.',
  );
  results.confirmedFork = {historicalAttachmentPreserved: true};
  // A guard on the main context alone misses the host's separate title and
  // generate requests. Establish real positive controls for both paths first.
  const titled = unwrap<{id: string}>(await json('/api/session', {}));
  const titleStart: number = providerRequests.length;
  await json(`/api/session/${titled.id}/prompt`, {
    text: 'GENUINE_UNNAMED_SESSION_TITLE',
  });
  await waitSession(titled.id);
  await until(async () => {
    const current = unwrap<{title: string}>(
      await json(`/api/session/${titled.id}`),
    );
    return current.title === 'Controlled response.';
  }, 'accepted unnamed-session title');
  assert.ok(
    JSON.stringify(providerRequests.slice(titleStart)).includes(
      'GENUINE_UNNAMED_SESSION_TITLE',
    ),
  );
  const generated = unwrap<{text: string}>(
    await json(`/api/session/${titled.id}/generate`, {
      prompt: 'GENUINE_GENERATE_CONTROL',
    }),
  );
  assert.equal(generated.text, 'Controlled response.');
  results.auxiliaryPositiveControls = {
    acceptedTitle: 'Controlled response.',
    generatedText: generated.text,
  };
  await json(`/api/session/${titled.id}/prompt`, {
    text: 'GENUINE_BEFORE_COMPACTION',
  });
  await waitSession(titled.id);
  const positiveCompactStart: number = providerRequests.length;
  await json(`/api/session/${titled.id}/compact`, {});
  await waitSession(titled.id);
  const compacted = unwrap<Array<Record<string, unknown>>>(
    await json(`/api/session/${titled.id}/context`),
  );
  assert.ok(providerRequests.length > positiveCompactStart);
  assert.ok(
    compacted.some(
      row => row.type === 'compaction' && row.status === 'completed',
    ),
    'The positive control must install a completed checkpoint.',
  );
  const afterCompactStart: number = providerRequests.length;
  await json(`/api/session/${titled.id}/prompt`, {
    text: 'GENUINE_AFTER_COMPLETED_COMPACTION',
  });
  await waitSession(titled.id);
  assert.ok(
    JSON.stringify(providerRequests.slice(afterCompactStart)).includes(
      'GENUINE_AFTER_COMPLETED_COMPACTION',
    ),
  );
  results.confirmedCompaction = {
    completedCheckpoint: true,
    genuineFollowupDelivered: true,
  };
  const afterCheckpointStart: number = providerRequests.length;
  await json(`/api/session/${titled.id}/command`, {
    name: 'goal',
    text: 'ACCEPTED_GOAL_AFTER_COMPACTION',
    files,
  });
  await waitSession(titled.id);
  assert.ok(
    JSON.stringify(providerRequests.slice(afterCheckpointStart)).includes(
      'ACCEPTED_GOAL_AFTER_COMPACTION',
    ),
    'A clean checkpoint must not block a newly admitted native goal.',
  );
  // Cancelled A settles while replacement B is still preparing. A's genuine
  // host execution-failed event must not corrupt B's accepted state/revision.
  const replacement = unwrap<{id: string}>(
    await json('/api/session', {title: 'Replacement admission isolation'}),
  );
  const replacementStart: number = providerRequests.length;
  const delayedGoal = (label: string) => {
    const path = join(work, `replacement-${label}.txt`);
    writeFileSync(path, `REPLACEMENT_ATTACHMENT_${label}`);
    return fetch(baseURL + `/api/session/${replacement.id}/command`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        name: 'goal',
        text: `Replacement objective ${label}`,
        files: [{uri: `file://${path}`, name: `replacement-${label}.txt`}],
      }),
    }).then(async response => ({
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    }));
  };
  await rpc('arm', replacement.id);
  const replacingA = delayedGoal('A');
  await until(
    async () => (await rpc('state', replacement.id)).output.entered === true,
    'first replacement prompt preparation',
  );
  await rpc('arm', replacement.id);
  const replacingB = delayedGoal('B');
  await until(
    async () => (await rpc('state', replacement.id)).output.entered === true,
    'second replacement prompt preparation',
  );
  await rpc('release', replacement.id);
  const rejectedA = await replacingA;
  assert.equal(rejectedA.ok, false);
  await waitSession(replacement.id);
  await until(
    () =>
      events.some(
        event =>
          event.type === 'session.execution.failed' &&
          event.data.sessionID === replacement.id,
      ),
    'cancelled first command execution failure',
  );
  const replacementState = JSON.parse(
    readFileSync(
      join(
        work,
        '.opencode',
        'goals',
        'sessions',
        replacement.id,
        'state.json',
      ),
      'utf8',
    ),
  ) as {
    goals: Array<{condition: string; status: string; promptFailures: number}>;
  };
  assert.equal(replacementState.goals.length, 1);
  assert.equal(replacementState.goals[0].condition, 'Replacement objective B');
  assert.equal(replacementState.goals[0].status, 'active');
  assert.equal(replacementState.goals[0].promptFailures, 0);
  await rpc('release', replacement.id);
  const acceptedB = await replacingB;
  assert.equal(acceptedB.ok, true, acceptedB.text);
  await waitSession(replacement.id);
  const replacementRequests = JSON.stringify(
    providerRequests.slice(replacementStart),
  );
  assert.equal(replacementRequests.includes('REPLACEMENT_ATTACHMENT_A'), false);
  assert.ok(replacementRequests.includes('REPLACEMENT_ATTACHMENT_B'));
  results.replacementAdmission = {
    rejectedA,
    acceptedB,
    newerGoalFailures: replacementState.goals[0].promptFailures,
    cancelledAttachmentDelivered: false,
    replacementAttachmentDelivered: true,
  };
  const cancelled: Array<{
    sessionID: string;
    forkID: string;
    marker: string;
    uncompacted: boolean;
  }> = [];
  for (const action of ['pause', 'clear', 'compact']) {
    const current = unwrap<{id: string}>(
      await json(
        '/api/session',
        action === 'pause' ? {} : {title: `Cancelled admission ${action}`},
      ),
    );
    const marker = `CANCELLED_ATTACHMENT_${action.toUpperCase()}`;
    const commandMarker = `CANCELLED_COMMAND_${action.toUpperCase()}`;
    const path = join(work, `${action}-cancelled.txt`);
    writeFileSync(path, `${marker}: this input must never reach a model.`);
    if (action === 'compact') {
      // Make the cancelled input the newest raw exchange, so the host's kept
      // tail would include it even when the summary request was filtered.
      for (const turn of [1, 2]) {
        await json(`/api/session/${current.id}/prompt`, {
          text: `GENUINE_BEFORE_CANCELLED_TAIL_${turn}`,
        });
        await waitSession(current.id);
      }
    }
    await rpc('arm', current.id);
    const requestStart: number = providerRequests.length;
    const pending = fetch(baseURL + `/api/session/${current.id}/command`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        name: 'goal',
        text: `${commandMarker}: inspect delayed ${action} requirements`,
        files: [{uri: `file://${path}`, name: `${action}-cancelled.txt`}],
      }),
    }).then(async response => ({
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    }));
    await until(
      async () => (await rpc('state', current.id)).output.entered === true,
      `${action} after prompt admission checks`,
    );
    await json(`/api/session/${current.id}/command`, {
      name: 'goal',
      text: action === 'compact' ? 'pause' : action,
    });
    await rpc('release', current.id);
    const commandResult = await pending;
    await waitSession(current.id);
    const cancelledAttachmentDelivered = JSON.stringify(
      providerRequests.slice(requestStart),
    ).includes(marker);
    results[`cancelled-${action}`] = {
      commandResult,
      cancelledAttachmentDelivered,
    };
    assert.equal(
      cancelledAttachmentDelivered,
      false,
      'Late materialization cannot deliver a cancelled attachment.',
    );
    assert.equal(
      JSON.stringify(providerRequests.slice(requestStart)).includes(
        commandMarker,
      ),
      false,
      'The separate automatic title request must not use the cancelled objective.',
    );
    assert.equal(
      commandResult.ok,
      false,
      'The cancelled command must report that admission was not completed.',
    );
    const history = unwrap<Array<Record<string, unknown>>>(
      await json(`/api/session/${current.id}/context`),
    );
    const cancelledMessage = history.find(
      row =>
        row.type === 'user' &&
        JSON.stringify(row).includes(`${action}-cancelled.txt`),
    );
    assert.ok(
      cancelledMessage,
      'The actual host admitted the delayed valid file; the execution fence must suppress it.',
    );
    const durable = JSON.parse(
      readFileSync(
        join(work, '.opencode', 'goals', 'sessions', current.id, 'state.json'),
        'utf8',
      ),
    ) as {unconfirmedKickoffInputs?: Array<{inputID?: string}>};
    assert.ok(
      durable.unconfirmedKickoffInputs?.some(
        entry => entry.inputID === cancelledMessage.id,
      ),
      'The unconfirmed input guard must survive even when clear removed every goal.',
    );
    if (action === 'compact') {
      const beforeCompact: number = providerRequests.length;
      const response = await fetch(
        baseURL + `/api/session/${current.id}/compact`,
        {
          method: 'POST',
          headers,
          body: '{}',
        },
      );
      const responseText = await response.text();
      await waitSession(current.id);
      const afterCompact = unwrap<Array<Record<string, unknown>>>(
        await json(`/api/session/${current.id}/context`),
      );
      assert.equal(
        afterCompact.some(
          row => row.type === 'compaction' && row.status === 'completed',
        ),
        false,
        'A summary cannot safely install the host-kept cancelled tail.',
      );
      assert.equal(
        providerRequests.length,
        beforeCompact,
        'Affected compaction must be refused before any summary model request.',
      );
      results.cancelledTailCompaction = {
        status: response.status,
        responseText,
        completedCheckpoint: false,
        providerRequests: 0,
      };
    }
    const fork = unwrap<{id: string}>(
      await json(`/api/session/${current.id}/fork`, {}),
    );
    const forkedHistory = unwrap<Array<Record<string, unknown>>>(
      await json(`/api/session/${fork.id}/context`),
    );
    const copied = forkedHistory.find(
      row =>
        row.type === 'user' &&
        JSON.stringify(row).includes(`${action}-cancelled.txt`),
    );
    assert.ok(
      copied && copied.id !== cancelledMessage.id,
      'The real fork must mint a different message ID.',
    );
    for (const target of [current.id, fork.id]) {
      const genuine = `GENUINE_INPUT_${action}_${target}`;
      const before: number = providerRequests.length;
      await json(`/api/session/${target}/prompt`, {text: genuine});
      await waitSession(target);
      const requests: string = JSON.stringify(providerRequests.slice(before));
      assert.ok(
        requests.includes(genuine),
        'A later genuine input must still reach the model.',
      );
      assert.equal(
        requests.includes(marker),
        false,
        'Cancelled history must remain filtered, including after fork.',
      );
      const beforeGenerate: number = providerRequests.length;
      const generatePrompt = `GENUINE_GENERATE_${action}_${target}`;
      const generated = unwrap<{text: string}>(
        await json(`/api/session/${target}/generate`, {
          prompt: generatePrompt,
        }),
      );
      assert.equal(generated.text, 'Controlled response.');
      const generateRequests: string = JSON.stringify(
        providerRequests.slice(beforeGenerate),
      );
      assert.ok(generateRequests.includes(generatePrompt));
      assert.equal(
        generateRequests.includes(marker) ||
          generateRequests.includes(commandMarker),
        false,
        'Explicit generation must filter cancelled input history.',
      );
    }
    cancelled.push({
      sessionID: current.id,
      forkID: fork.id,
      marker,
      uncompacted: true,
    });
    results[`cancelled-${action}`] = {
      commandResult,
      originalMessageID: cancelledMessage.id,
      forkedMessageID: copied.id,
      laterInputDelivered: true,
      cancelledAttachmentDelivered: false,
      cancelledTitleObjectiveDelivered: false,
      explicitGenerationFiltered: true,
    };
  }
  // Recovery uses a new process and only persisted plugin/host state.
  controller.abort();
  await eventTask.catch(() => {});
  await host.stop();
  host = bootHost();
  await until(() => Boolean(baseURL), 'restarted host startup');
  for (const {sessionID, forkID, marker, uncompacted} of cancelled) {
    for (const target of [sessionID, forkID]) {
      if (uncompacted) {
        const history = await json(`/api/session/${target}/context`);
        assert.ok(
          JSON.stringify(history).includes('-cancelled.txt'),
          'Cold recovery must be tested with cancelled history still present.',
        );
      }
      const genuine = `GENUINE_AFTER_RESTART_${target}`;
      const before: number = providerRequests.length;
      await json(`/api/session/${target}/prompt`, {text: genuine});
      await waitSession(target);
      const requests: string = JSON.stringify(providerRequests.slice(before));
      assert.ok(
        requests.includes(genuine),
        'A genuine input after restart must still run.',
      );
      assert.equal(
        requests.includes(marker),
        false,
        'Restart must retain cancelled input protection in original and forked sessions.',
      );
    }
  }
  results.restart = {
    newProcess: true,
    originalAndForkedSessions: cancelled.length * 2,
    uncompactedCancelledHistory: true,
  };
  results.passed = true;
  console.log(JSON.stringify(results, null, 2));
} finally {
  releaseHeld();
  controller.abort();
  await eventTask.catch(() => {});
  disposeOutput();
  await host.stop();
  provider.stop(true);
  writeFileSync(join(root, 'host.log'), stderr);
  writeFileSync(join(root, 'host-stdout.log'), stdout);
  writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
  writeFileSync(
    join(root, 'provider-requests.json'),
    JSON.stringify(providerRequests, null, 2),
  );
  console.log(`Evidence: ${root}`);
}
