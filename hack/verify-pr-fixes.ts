/**
 * Real OpenCode 2.2.7 checks against a local deterministic provider.
 * OPENCODE_BINARY=/path/to/opencode bun hack/verify-pr-fixes.ts
 * The process, git workspace, config, provider, and state are all isolated.
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
const version = Bun.spawnSync([binary, '--version']);
assert.equal(version.exitCode, 0);
const hostVersion = version.stdout.toString().trim();
assert.match(hostVersion, /\bv?2\./, 'Expected an OpenCode v2 binary.');

type RequestBody = {messages?: unknown[]; model?: string};
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
    if (JSON.stringify(body.messages).includes('HOLD_OUTPUT_TEST') && !held) {
      held = true;
      await new Promise<void>(resolve => {
        releaseHeld = resolve;
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
            delta: {role: 'assistant', content: 'Controlled response.'},
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
  {
    cwd: work,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  },
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
async function json(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(baseURL + path, {
    method: body === undefined ? 'GET' : 'POST',
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
const controller = new AbortController();
let eventTask = Promise.resolve();
let receive: (event: {data: unknown}) => void = () => {};
let activeSession = '';
const displayed: string[] = [];
const events: Array<{type: string; data: Record<string, unknown>}> = [];
const disposeOutput = wireGoalCommandOutput({
  client: {
    rpc: () => ({
      events: {
        on: (_name, handler) => {
          receive = handler;
          return () => {};
        },
      },
    }),
  },
  ui: {
    router: {current: () => ({type: 'session', sessionID: activeSession})},
    dialog: {
      alert: async input => {
        displayed.push(input.message);
      },
    },
    toast: {show: () => {}},
  },
});
const results: Record<string, unknown> = {hostVersion};
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
  results.passed = true;
  console.log(JSON.stringify(results, null, 2));
} finally {
  releaseHeld();
  controller.abort();
  await eventTask.catch(() => {});
  disposeOutput();
  child.kill('SIGTERM');
  const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  await child.exited;
  clearTimeout(killTimer);
  await Promise.all([stdoutTask, stderrTask]);
  provider.stop(true);
  writeFileSync(join(root, 'host.log'), stderr);
  writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
  writeFileSync(
    join(root, 'provider-requests.json'),
    JSON.stringify(providerRequests, null, 2),
  );
  console.log(`Evidence: ${root}`);
}
