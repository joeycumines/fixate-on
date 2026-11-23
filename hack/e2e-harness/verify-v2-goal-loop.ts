import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';

const HARNESS_DIR = import.meta.dir;
const REPO_ROOT = resolve(HARNESS_DIR, '..', '..');
const ISOLATED_BASE = join(HARNESS_DIR, '.isolated-v2-loop');
const PLUGIN_DIR = join(HARNESS_DIR, 'plugin-dir');

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function resolveOpencode2Bin(): string {
  const configured = process.env.E2E_OPENCODE2_BIN?.trim() || 'opencode2';
  const resolved = configured.includes('/') ? configured : Bun.which(configured);
  assert(resolved && existsSync(resolved), `opencode2 binary not found: ${configured}`);
  return resolved;
}

function makeSseResponse(
  id: string,
  model: string,
  options: {
    content?: string;
    toolCalls?: Array<{id: string; name: string; arguments: string}>;
    finishReason?: string;
  },
): Response {
  const created = Math.floor(Date.now() / 1000);
  const chunks: Array<Record<string, unknown>> = [];
  if (options.toolCalls && options.toolCalls.length > 0) {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: options.toolCalls.map((tc, index) => ({
              index,
              id: tc.id,
              type: 'function',
              function: {name: tc.name, arguments: tc.arguments},
            })),
          },
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{index: 0, delta: {}, finish_reason: options.finishReason ?? 'tool_calls'}],
      usage: {prompt_tokens: 120, completion_tokens: 25, total_tokens: 145},
    });
  } else {
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {role: 'assistant', content: options.content ?? 'Done.'},
          finish_reason: null,
        },
      ],
    });
    chunks.push({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{index: 0, delta: {}, finish_reason: options.finishReason ?? 'stop'}],
      usage: {prompt_tokens: 140, completion_tokens: 20, total_tokens: 160},
    });
  }
  const sse = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(sse, {
    status: 200,
    headers: {'Content-Type': 'text/event-stream; charset=utf-8'},
  });
}

interface RequestLog {
  seq: number;
  kind: 'title' | 'compaction' | 'judge' | 'agent';
  roles: string[];
  sysText: string;
  toolNames: string[];
  lastUser: string;
}

function classifyAndRespond(
  seq: number,
  body: Record<string, unknown>,
  onAgentTurn: (ctx: {
    msgs: Array<{role: string; content: unknown}>;
    tools: string[];
    userCount: number;
    toolResultCount: number;
    lastUser: string;
  }) => {content?: string; toolCalls?: Array<{id: string; name: string; arguments: string}>},
): {log: RequestLog; response: Response} {
  const msgs = (body.messages as Array<{role: string; content: unknown}> | undefined) ?? [];
  const model = String(body.model ?? 'mock-model');
  const sysText = msgs
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
  const rawLastUser = msgs.filter(m => m.role === 'user').slice(-1)[0]?.content;
  const lastUser = typeof rawLastUser === 'string' ? rawLastUser : JSON.stringify(rawLastUser ?? '');
  const tools = ((body.tools as Array<{function?: {name?: string}}>) ?? [])
    .map(t => t.function?.name ?? '')
    .filter(Boolean);

  if (sysText.includes('title generator') || lastUser.includes('Reply with only the title')) {
    return {
      log: {seq, kind: 'title', roles: msgs.map(m => m.role), sysText, toolNames: tools, lastUser},
      response: makeSseResponse(`t-${seq}`, model, {content: 'V2 E2E Session'}),
    };
  }

  const combinedPrompt = `${sysText}\n${lastUser}`;
  const lowerCombined = combinedPrompt.toLowerCase();
  if (lowerCombined.includes('summarize only what') || lowerCombined.includes('summarize the conversation')) {
    return {
      log: {seq, kind: 'compaction', roles: msgs.map(m => m.role), sysText, toolNames: tools, lastUser},
      response: makeSseResponse(`c-${seq}`, model, {
        content: '## Objective\n- Active goal checkpoint\n## Work State\n### Active\n- Preserved',
      }),
    };
  }
  if (combinedPrompt.includes('Classify the goal into exactly one state:')) {
    const taskMatch = combinedPrompt.match(/task_id for this goal:\s*([^\s\n]+)/);
    const taskId = taskMatch?.[1] ?? '';
    const verdict = JSON.stringify({
      schema_version: 1,
      task_id: taskId,
      state: 'COMPLETE',
      outstanding: [],
      evidence: ['checked deliverable and tool output'],
    });
    return {
      log: {seq, kind: 'judge', roles: msgs.map(m => m.role), sysText, toolNames: tools, lastUser},
      response: makeSseResponse(`j-${seq}`, model, {content: verdict}),
    };
  }

  const userCount = msgs.filter(m => m.role === 'user').length;
  const toolResultCount = msgs.filter(m => m.role === 'tool').length;
  const reply = onAgentTurn({msgs, tools, userCount, toolResultCount, lastUser});
  return {
    log: {seq, kind: 'agent', roles: msgs.map(m => m.role), sysText, toolNames: tools, lastUser},
    response: makeSseResponse(`a-${seq}`, model, reply),
  };
}

function readSessionState(workDir: string, sid: string): Record<string, unknown> | null {
  const path = join(workDir, '.opencode', 'goals', 'sessions', sid, 'state.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

async function pollUntil<T>(fn: () => T | null, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = fn();
    if (val != null) return val;
    await Bun.sleep(200);
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function prepareIsolatedCase(name: string) {
  const dir = join(ISOLATED_BASE, name);
  rmSync(dir, {recursive: true, force: true});
  const workDir = join(dir, 'work');
  const otherCwd = join(dir, 'other-cwd');
  const xdgConfig = join(dir, 'xdg-config');
  const xdgData = join(dir, 'xdg-data');
  const xdgState = join(dir, 'xdg-state');
  const xdgCache = join(dir, 'xdg-cache');
  const opencodeConfigDir = join(xdgConfig, 'opencode');
  mkdirSync(workDir, {recursive: true});
  mkdirSync(otherCwd, {recursive: true});
  mkdirSync(opencodeConfigDir, {recursive: true});
  mkdirSync(join(xdgData, 'opencode'), {recursive: true});
  mkdirSync(join(xdgState, 'opencode'), {recursive: true});
  mkdirSync(join(xdgCache, 'opencode'), {recursive: true});
  Bun.spawnSync(['git', 'init', '-q'], {cwd: workDir});
  writeFileSync(join(workDir, 'README.md'), '# e2e work\n');
  return {dir, workDir, otherCwd, xdgConfig, xdgData, xdgState, xdgCache, opencodeConfigDir};
}

function makeEnv(
  dirs: ReturnType<typeof prepareIsolatedCase>,
  serveCwd: string,
  eventLog: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PWD: serveCwd,
    MOCK_API_KEY: 'dummy',
    OPENCODE_PASSWORD: 'e2e',
    OPENCODE_SERVER_PASSWORD: 'e2e',
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_STATE_HOME: dirs.xdgState,
    XDG_CACHE_HOME: dirs.xdgCache,
    OPENCODE_CONFIG_DIR: dirs.opencodeConfigDir,
    OPENCODE_CONFIG: join(dirs.opencodeConfigDir, 'opencode.json'),
    FIXATE_ON_EVENT_LOG: eventLog,
  };
  delete env.OPENCODE_TUI_CONFIG;
  delete env.OPENCODE_CONFIG_CONTENT;
  // The campaign is isolated: never inherit a developer's external state root.
  // Cases set their own absolute stateRoot explicitly.
  delete env.FIXATE_ON_STATE_ROOT;
  return env;
}

async function bootServe(opencode2Bin: string, serveCwd: string, env: Record<string, string | undefined>) {
  const srv = Bun.spawn(
    [opencode2Bin, '--print-logs', '--log-level', 'info', 'serve', '--hostname', '127.0.0.1', '--port', '0'],
    {cwd: serveCwd, env, stdout: 'pipe', stderr: 'pipe'},
  );
  const dec = new TextDecoder();
  const stdoutChunks: string[] = [];
  const outReader = srv.stdout.getReader();
  const errReader = srv.stderr.getReader();
  const errChunks: string[] = [];
  const drainErr = (async () => {
    while (true) {
      const {done, value} = await errReader.read();
      if (done) break;
      errChunks.push(dec.decode(value, {stream: true}));
    }
  })();

  // Cleanup is owned from the moment the child exists, including startup failure.
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return errChunks.join('');
    cleanupStarted = true;
    srv.kill('SIGTERM');
    const drained = Promise.all([
      srv.exited,
      (async () => {
        while (true) {
          const {done} = await outReader.read().catch(() => ({done: true}));
          if (done) break;
        }
      })(),
      drainErr,
    ]);
    // Bound shutdown: a child that ignores SIGTERM must not hang the campaign.
    await Promise.race([
      drained,
      new Promise<void>(resolve => {
        const t = setTimeout(() => {
          srv.kill('SIGKILL');
          resolve();
        }, 2000);
        t.unref?.();
      }),
    ]);
    return errChunks.join('');
  };

  const startupDeadlineMs = 10_000;
  let urlTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<symbol>(resolve => {
    urlTimer = setTimeout(() => resolve(Symbol('serve startup deadline')), startupDeadlineMs);
  });
  const foundUrl = (async () => {
    let buffered = '';
    while (true) {
      const {done, value} = await outReader.read();
      if (done) return '';
      buffered += dec.decode(value, {stream: true});
      stdoutChunks.push(buffered);
      const match = buffered.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) return match[0];
    }
  })();

  let baseUrl: string | symbol;
  try {
    baseUrl = await Promise.race([foundUrl, deadline]);
  } finally {
    if (urlTimer) clearTimeout(urlTimer);
  }
  if (typeof baseUrl !== 'string' || !baseUrl) {
    await cleanup();
    assert(false, `serve failed to bind within ${startupDeadlineMs}ms; stdout=${stdoutChunks.join('')}; stderr=${errChunks.join('')}`);
  }

  return {
    baseUrl,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Basic ' + Buffer.from('opencode:e2e').toString('base64'),
    },
    async stop() {
      return cleanup();
    },
  };
}

async function runCase1SlashGoalAndSettlement(opencode2Bin: string): Promise<void> {
  const dirs = prepareIsolatedCase('case1-slash-goal-and-settlement');
  const logs: RequestLog[] = [];
  let seq = 0;

  const llm = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', {status: 404});
      const body = (await req.json()) as Record<string, unknown>;
      seq += 1;
      const {log, response} = classifyAndRespond(seq, body, ({tools, toolResultCount, userCount}) => {
        if (toolResultCount === 0 && tools.includes('write')) {
          return {
            toolCalls: [
              {
                id: `tc_write_${seq}`,
                name: 'write',
                arguments: JSON.stringify({path: join(dirs.workDir, 'alpha.txt'), content: 'verified v2 alpha\n'}),
              },
            ],
          };
        }
        if (userCount === 1) {
          return {content: 'Wrote alpha.txt in Turn 1.'};
        }
        if (toolResultCount === 1 && userCount >= 2 && tools.includes('update_goal')) {
          return {
            toolCalls: [{id: `tc_done_${seq}`, name: 'update_goal', arguments: JSON.stringify({status: 'complete'})}],
          };
        }
        return {content: 'Completion claimed via update_goal.'};
      });
      logs.push(log);
      return response;
    },
  });

  // Intentionally omit commands.goal and workspaceDirectory to verify:
  // (1) ctx.command.transform overrides built-in opencode.goal cleanly;
  // (2) ctx.location.directory scopes state cleanly without workspaceDirectory option.
  writeFileSync(
    join(dirs.opencodeConfigDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          mock: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MockProvider',
            env: ['MOCK_API_KEY'],
            options: {baseURL: `http://127.0.0.1:${llm.port}/v1`},
            models: {'mock-model': {name: 'Mock Model', limit: {context: 131072, output: 8192}}},
          },
        },
        plugins: [`file://${PLUGIN_DIR}`],
        model: 'mock/mock-model',
      },
      null,
      2,
    ),
  );

  const eventLog = join(dirs.dir, 'events.jsonl');
  const srv = await bootServe(opencode2Bin, dirs.workDir, makeEnv(dirs, dirs.workDir, eventLog));
  let stderr = '';
  try {
    const createRes = await fetch(`${srv.baseUrl}/api/session`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({}),
    });
    const created = (await createRes.json()) as {id?: string; data?: {id?: string}};
    const sid = created.data?.id ?? created.id ?? '';
    assert(sid.length > 0, `expected session id from /api/session: ${JSON.stringify(created)}`);

    const goalCmdRes = await fetch(`${srv.baseUrl}/api/session/${sid}/command`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({name: 'goal', text: 'Write alpha.txt and settle honestly'}),
    });
    assert(goalCmdRes.ok, `/goal start failed: ${goalCmdRes.status}`);

    const settledState = await pollUntil(
      () => {
        const s = readSessionState(dirs.workDir, sid) as {
          goals?: Array<{status?: string}>;
          results?: Array<{state?: string; reason?: string; evidence?: string}>;
        } | null;
        if (!s) return null;
        const doneResult = s.results?.find(r => r.state === 'achieved');
        if (doneResult && (s.goals?.length ?? 0) === 0) return s;
        return null;
      },
      15_000,
      'case1 honest settlement in state.json results',
    );

    const reqCountBeforeStatus = logs.length;
    const statusRes = await fetch(`${srv.baseUrl}/api/session/${sid}/command`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({name: 'goal', text: 'status'}),
    });
    assert(statusRes.ok, `/goal status failed: ${statusRes.status}`);
    await Bun.sleep(400);
    // On newer 2.x hosts the verifier's result is delivered back to the parent
    // as an asynchronous agent turn just after settlement; that is host traffic,
    // not a turn caused by /goal status. Only a status-triggered turn fails.
    const statusTurns = logs
      .slice(reqCountBeforeStatus)
      .filter(l => !l.lastUser.includes('<subagent sessionID='));
    assert(statusTurns.length === 0, `/goal status must not trigger an LLM turn (found ${statusTurns.length})`);

    const ctxRes = await fetch(`${srv.baseUrl}/api/session/${sid}/context`, {headers: srv.headers});
    assert(ctxRes.ok, `GET /api/session/:id/context failed: ${ctxRes.status}`);
    const ctxJson = (await ctxRes.json()) as {data?: Array<Record<string, unknown>>};
    const ctxEntries = ctxJson.data ?? [];

    assert(existsSync(join(dirs.workDir, 'alpha.txt')), 'alpha.txt was not written');
    assert(readFileSync(join(dirs.workDir, 'alpha.txt'), 'utf8') === 'verified v2 alpha\n', 'alpha.txt content mismatch');

    const agentLogs = logs.filter(l => l.kind === 'agent');
    const judgeLogs = logs.filter(l => l.kind === 'judge');
    assert(agentLogs.length >= 2, `expected >= 2 agent turns (write + update_goal), got ${agentLogs.length}`);
    for (const l of agentLogs) {
      // A subagent result delivered back to the parent after settlement is a
      // legitimate turn without goal context: the goal is already terminal.
      const isPostSettlementSubagentResult = l.lastUser.includes('<subagent sessionID=');
      if (isPostSettlementSubagentResult) continue;
      assert(l.sysText.includes('<fixate_on'), `agent req#${l.seq} missing <fixate_on system prompt`);
    }
    assert(judgeLogs.length >= 1, `expected child-session judge request, got ${judgeLogs.length}`);
    assert(
      ctxEntries.some(e => e.type === 'assistant'),
      'GET /api/session/:id/context missing assistant entries',
    );
    assert(settledState.results?.length === 1, 'expected settled goal in results archive');
    console.log(`PASS[v2-case1]: zero-config /goal override + ctx.location + experimental.idle + judge settlement (${agentLogs.length} agent turns, ${judgeLogs.length} judge turn)`);
  } finally {
    stderr = await srv.stop();
    llm.stop(true);
  }
  assert(!stderr.includes('configured plugin path must be a directory'), `plugin directory warning emitted:\n${stderr}`);
}

async function runCase2CompactionBrakeAndWorkspaceScope(opencode2Bin: string): Promise<void> {
  const dirs = prepareIsolatedCase('case2-compaction-brake-location');
  const logs: RequestLog[] = [];
  let seq = 0;

  const llm = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', {status: 404});
      const body = (await req.json()) as Record<string, unknown>;
      seq += 1;
      const {log, response} = classifyAndRespond(seq, body, ({tools, toolResultCount, lastUser}) => {
        if (toolResultCount === 0 && tools.includes('goal-command') && lastUser.includes('goal-command')) {
          return {
            toolCalls: [
              {
                id: `tc_gc_${seq}`,
                name: 'goal-command',
                arguments: JSON.stringify({subcommand: 'Monitor progress cleanly'}),
              },
            ],
          };
        }
        return {content: `Tool-free status note ${seq}`};
      });
      logs.push(log);
      return response;
    },
  });

  writeFileSync(
    join(dirs.opencodeConfigDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          mock: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MockProvider',
            env: ['MOCK_API_KEY'],
            options: {baseURL: `http://127.0.0.1:${llm.port}/v1`},
            models: {'mock-model': {name: 'Mock Model', limit: {context: 131072, output: 8192}}},
          },
        },
        plugins: [
          {
            package: `file://${PLUGIN_DIR}`,
            options: {
              stateRoot: '.opencode/goals',
              workspaceDirectory: dirs.workDir,
              sdkShape: 'flat',
            },
          },
        ],
        command: {
          goal: {
            description: 'Run a goal loop',
            template: 'Call the goal-command tool once with subcommand: $ARGUMENTS',
          },
        },
        model: 'mock/mock-model',
      },
      null,
      2,
    ),
  );

  const eventLog = join(dirs.dir, 'events.jsonl');
  const srv = await bootServe(opencode2Bin, dirs.otherCwd, makeEnv(dirs, dirs.otherCwd, eventLog));
  let stderr = '';
  try {
    const createRes = await fetch(`${srv.baseUrl}/api/session`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({}),
    });
    const created = (await createRes.json()) as {id?: string; data?: {id?: string}};
    const sid = created.data?.id ?? created.id ?? '';
    assert(sid.length > 0, 'expected session id for case2');

    const cmdRes = await fetch(`${srv.baseUrl}/api/session/${sid}/command`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({name: 'goal', text: 'Monitor progress cleanly'}),
    });
    assert(cmdRes.ok, `commands.goal execution failed: ${cmdRes.status}`);

    const pausedGoal = await pollUntil(
      () => {
        const s = readSessionState(dirs.workDir, sid) as {
          goals?: Array<{status?: string; noToolCallTurns?: number; turnCount?: number}>;
        } | null;
        const g = s?.goals?.[0];
        if (g?.status === 'paused' && (g.noToolCallTurns ?? 0) >= 3) return g;
        return null;
      },
      15_000,
      'case2 no-tool-call pause after Turn 1 goal-command',
    );

    const compactRes = await fetch(`${srv.baseUrl}/api/session/${sid}/compact`, {
      method: 'POST',
      headers: srv.headers,
      body: JSON.stringify({}),
    });
    assert(compactRes.ok, `POST /api/session/:id/compact failed: ${compactRes.status}`);

    const compactLog = await pollUntil(
      () => logs.find(l => l.kind === 'compaction') ?? null,
      10_000,
      'case2 compaction request to mock LLM',
    );
    assert(compactLog.sysText.includes('<goal_context'), 'compaction request missing <goal_context injected by session.hook("compaction")');
    assert(!existsSync(join(dirs.otherCwd, '.opencode')), 'goal state leaked into wrong serve cwd');
    console.log(
      `PASS[v2-case2]: commands.goal coexistence + workspaceDirectory scope + noToolCallTurns=${pausedGoal.noToolCallTurns} brake + compaction <goal_context>`,
    );
  } finally {
    stderr = await srv.stop();
    llm.stop(true);
  }
  assert(!stderr.includes('configured plugin path must be a directory'), `plugin directory warning emitted:\n${stderr}`);
}

async function runCase3StandaloneRunContinuation(opencode2Bin: string): Promise<void> {
  const dirs = prepareIsolatedCase('case3-standalone-run');
  const logs: RequestLog[] = [];
  let seq = 0;

  const llm = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/chat/completions')) return new Response('not found', {status: 404});
      const body = (await req.json()) as Record<string, unknown>;
      seq += 1;
      const {log, response} = classifyAndRespond(seq, body, ({tools, toolResultCount, userCount}) => {
        if (toolResultCount === 0 && tools.includes('create_goal')) {
          return {
            toolCalls: [
              {
                id: `tc_create_${seq}`,
                name: 'create_goal',
                arguments: JSON.stringify({objective: 'Create beta.txt and complete honestly'}),
              },
            ],
          };
        }
        if (toolResultCount === 1 && tools.includes('write')) {
          return {
            toolCalls: [
              {
                id: `tc_write_${seq}`,
                name: 'write',
                arguments: JSON.stringify({path: join(dirs.workDir, 'beta.txt'), content: 'standalone v2 beta\n'}),
              },
            ],
          };
        }
        if (userCount === 1) {
          return {content: 'Wrote beta.txt, awaiting experimental.idle continuation.'};
        }
        if (toolResultCount === 2 && userCount >= 2 && tools.includes('update_goal')) {
          return {
            toolCalls: [{id: `tc_done_${seq}`, name: 'update_goal', arguments: JSON.stringify({status: 'complete'})}],
          };
        }
        return {content: 'Completion claimed for beta.txt.'};
      });
      logs.push(log);
      return response;
    },
  });

  writeFileSync(
    join(dirs.opencodeConfigDir, 'opencode.json'),
    JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          mock: {
            npm: '@ai-sdk/openai-compatible',
            name: 'MockProvider',
            env: ['MOCK_API_KEY'],
            options: {baseURL: `http://127.0.0.1:${llm.port}/v1`},
            models: {'mock-model': {name: 'Mock Model', limit: {context: 131072, output: 8192}}},
          },
        },
        plugins: [`file://${PLUGIN_DIR}`],
        model: 'mock/mock-model',
      },
      null,
      2,
    ),
  );

  const eventLog = join(dirs.dir, 'events.jsonl');
  const proc = Bun.spawn(
    [opencode2Bin, '--standalone', 'run', '--auto', '--model', 'mock/mock-model', 'Create a goal to write beta.txt and finish it.'],
    {cwd: dirs.workDir, env: makeEnv(dirs, dirs.workDir, eventLog), stdout: 'pipe', stderr: 'pipe'},
  );
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    proc.kill('SIGTERM');
    // A child that ignores SIGTERM (or leaves a grandchild holding the pipes)
    // otherwise hangs the campaign forever: stdout never EOFs. Escalate.
    killTimer = setTimeout(() => proc.kill('SIGKILL'), 2_000);
    killTimer.unref?.();
  }, 20_000);
  timer.unref?.();
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>(resolve => {
    deadlineTimer = setTimeout(() => resolve('deadline'), 24_000);
    deadlineTimer.unref?.();
  });
  const outcome = await Promise.race([
    Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]).then(result => ({result}) as const),
    deadline.then(() => ({timedOut: true} as const)),
  ]);
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  if ('timedOut' in outcome) proc.kill('SIGKILL');
  llm.stop(true);
  assert(!('timedOut' in outcome), 'standalone run did not terminate after SIGTERM and SIGKILL');
  const [stdout, stderr, exitCode] = outcome.result;

  assert(exitCode === 0, `standalone run exited ${exitCode}\nstdout=${stdout}\nstderr=${stderr}`);
  assert(existsSync(join(dirs.workDir, 'beta.txt')), 'beta.txt not written by standalone run');
  assert(readFileSync(join(dirs.workDir, 'beta.txt'), 'utf8') === 'standalone v2 beta\n', 'beta.txt mismatch');

  const sessionsDir = join(dirs.workDir, '.opencode', 'goals', 'sessions');
  const sids = existsSync(sessionsDir) ? readdirSync(sessionsDir) : [];
  assert(sids.length === 1, `expected 1 session dir in standalone workDir, found ${JSON.stringify(sids)}`);
  const state = readSessionState(dirs.workDir, sids[0]!) as {
    goals?: unknown[];
    results?: Array<{state?: string; reason?: string}>;
  } | null;
  assert(state?.results?.some(r => r.state === 'achieved'), `expected achieved result in standalone state: ${JSON.stringify(state)}`);
  const continuedTurns = logs.filter(
    l => l.kind === 'agent' && l.roles.filter(r => r === 'user').length >= 2 && l.sysText.includes('<fixate_on'),
  );
  assert(continuedTurns.length >= 1, 'standalone run did not trigger experimental.idle continuation with <fixate_on>');
  assert(logs.some(l => l.kind === 'judge'), 'standalone run did not execute child judge settlement');
  console.log(
    `PASS[v2-case3]: --standalone run experimental.idle continuation + <fixate_on> + judge settlement (exit=0, agentTurns=${logs.filter(l => l.kind === 'agent').length})`,
  );
}

async function main(): Promise<void> {
  assert(existsSync(join(REPO_ROOT, 'plugin', 'fixate-on', 'plugin.js')), 'missing plugin/fixate-on/plugin.js — run bun run bundle first');
  assert(existsSync(join(PLUGIN_DIR, 'server.js')) && existsSync(join(PLUGIN_DIR, 'tui.js')), `invalid plugin-dir at ${PLUGIN_DIR}`);

  const opencode2Bin = resolveOpencode2Bin();
  const ver = Bun.spawnSync([opencode2Bin, '--version']);
  const verStr = ver.stdout.toString().trim();
  console.log(`verify-v2-goal-loop: using ${opencode2Bin} (${verStr || 'unknown version'}) from ${dirname(opencode2Bin)}`);

  await runCase1SlashGoalAndSettlement(opencode2Bin);
  await runCase2CompactionBrakeAndWorkspaceScope(opencode2Bin);
  await runCase3StandaloneRunContinuation(opencode2Bin);
  rmSync(ISOLATED_BASE, {recursive: true, force: true});
  console.log('ALL V2 GOAL LOOP VERIFICATIONS PASSED');
}

await main();
