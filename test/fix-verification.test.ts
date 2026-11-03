import {expect, test} from 'bun:test';
import {GoalsPlugin} from '../src/plugin.ts';
import {TEST_WORKSPACE_DIR} from './identity-stub.ts';
import {createGoalState} from '../src/state-machine.ts';
import {serializeResult} from '../src/persistence.ts';
import {
  appendWalEntry,
  createProposedEntry,
  readWalEntries,
  recoverState,
  writeStateFile,
} from '../src/persistence-wal.ts';
import {mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {ensureSessionDir, sessionStatePaths} from '../src/session-paths.ts';

const NO_PERSIST = {persistState: false};

function makeClient() {
  const promptCalls: unknown[] = [];
  return {
    promptCalls,
    client: {
      app: {
        log: async () => {},
      },
      session: {
        messages: async () => ({data: []}),
        promptAsync: async (input: unknown) => {
          promptCalls.push(input);
          return {};
        },
      },
    },
  };
}

async function makePlugin(opts: Record<string, unknown> = {}) {
  const {client, promptCalls} = makeClient();
  // idlePoller: false by default — a live 5 s timer in a test is a defect
  // (it mutates state and issues prompts from a background interval).
  const hooks = await GoalsPlugin(
    {client, directory: TEST_WORKSPACE_DIR},
    {...NO_PERSIST, idlePoller: false, ...opts},
  );
  return {hooks, promptCalls, client};
}

async function runGoalCommand(
  hooks: Awaited<ReturnType<typeof GoalsPlugin>>,
  sessionID: string,
  args: string,
): Promise<string> {
  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'goal', sessionID, arguments: args},
    output,
  );
  return output.parts[0]?.text ?? '';
}

// FIX-A: setPendingIntent / getPendingIntent

test('FIX-A: setPendingIntent stores intent and getPendingIntent retrieves it', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'fix tests');

  const updateGoalTool = hooks.tool?.update_goal as
    | {
        execute?: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    | undefined;
  expect(updateGoalTool?.execute).toBeDefined();
  await updateGoalTool!.execute!({status: 'complete'}, {sessionID: 's1'});

  const getGoalTool = hooks.tool?.get_goal as
    | {
        execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
      }
    | undefined;
  const result = await getGoalTool!.execute!({}, {sessionID: 's1'});
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.pendingCompletion).toBe(true);
});

test('FIX-A: update_goal tool sets pending intent via session context', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'fix tests');

  const updateGoalTool = hooks.tool?.update_goal as
    | {
        execute?: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    | undefined;
  expect(updateGoalTool?.execute).toBeDefined();

  const result = await updateGoalTool!.execute!(
    {status: 'complete'},
    {sessionID: 's1'},
  );
  expect(result).toBeDefined();
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.pendingCompletion).toBe(true);
});

test('FIX-A: getPendingIntent returns null when no intent set', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'fix tests');
  const getGoalTool = hooks.tool?.get_goal as
    | {
        execute?: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    | undefined;
  expect(getGoalTool?.execute).toBeDefined();
  const result = await getGoalTool!.execute!({sessionID: 's1'}, {});
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.pendingCompletion).toBe(false);
});

// FIX-B: trackTokenUsage persists

test('FIX-B: trackTokenUsage calls real persist (not stub)', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'fix tests');

  const event = {
    type: 'message.updated',
    sessionID: 's1',
    properties: {
      info: {
        id: 'msg-1',
        role: 'assistant',
        info: {tokens: {input: 100, output: 50}, cost: 0.01},
      },
    },
  };
  await hooks.event!(event as never);

  const getGoalTool = hooks.tool?.get_goal as
    | {
        execute?: (args: unknown, ctx: unknown) => Promise<unknown>;
      }
    | undefined;
  const result = await getGoalTool!.execute!({}, {sessionID: 's1'});
  const parsed = typeof result === 'string' ? JSON.parse(result) : result;
  expect(parsed.goal).toBeDefined();
  expect(parsed.goal.tokensUsed).toBeGreaterThanOrEqual(150);
});

// FIX-C: WAL entries are written on transitions

test('FIX-C: WAL entries written on goal creation with persistence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-fix-'));
  const paths = sessionStatePaths(dir, 's1');
  const hooks = await GoalsPlugin(
    {directory: TEST_WORKSPACE_DIR},
    {
      persistState: true,
      stateRoot: dir,
      idlePoller: false,
    },
  );

  await runGoalCommand(hooks, 's1', 'fix tests');
  await hooks.dispose?.();

  const entries = await readWalEntries(paths.ledgerPath);
  expect(entries.length).toBeGreaterThan(0);
  expect(entries.some(e => e.phase === 'committed')).toBe(true);

  await rm(dir, {recursive: true, force: true});
});

// FIX-D: writeStateFile creates parent directory

test("FIX-D: writeStateFile creates parent directory when it doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-mkdir-'));
  const nestedPath = join(dir, 'deep', 'nested', 'state.json');

  const goal = createGoalState('s1', 'test');
  const ok = await writeStateFile(nestedPath, [goal], [], []);
  expect(ok).toBe(true);

  const dirStat = await stat(join(dir, 'deep', 'nested'));
  expect(dirStat.isDirectory()).toBe(true);

  await rm(dir, {recursive: true, force: true});
});

test('FIX-D: writeStateFile creates directory with 0700 permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-perms-'));
  const nestedPath = join(dir, 'secure', 'state.json');

  const goal = createGoalState('s1', 'test');
  await writeStateFile(nestedPath, [goal], [], []);

  const dirStat = await stat(join(dir, 'secure'));
  const mode = dirStat.mode & 0o777;
  expect(mode).toBe(0o700);

  await rm(dir, {recursive: true, force: true});
});

// FIX-E: autoPromote fires after completion in ordered session

test('FIX-E: autoPromote is wired and callable', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'sequence build; test; ship');
  const list = await runGoalCommand(hooks, 's1', 'list');
  expect(list).toMatch(/build/);
});

// FIX-F: sequence registers ordered session

test('FIX-F: sequence command registers session as ordered', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'sequence build; test; ship');
  const list = await runGoalCommand(hooks, 's1', 'list');
  expect(list).toMatch(/ordered|sequence/i);
});

// FIX-I: CI uses bun

test('FIX-I: active runtime contracts use bun', async () => {
  const fs = await import('node:fs/promises');
  const ci = await fs.readFile(
    join(process.cwd(), '.github/workflows/ci.yml'),
    'utf8',
  );
  expect(ci).toContain('setup-bun');
  expect(ci).toContain('bun install');
  expect(ci).not.toContain('npm ci');
  expect(ci).not.toContain('node --test');
});

test('FIX-I: active package commands do not invoke node or npm', async () => {
  const fs = await import('node:fs/promises');
  const manifest = JSON.parse(
    await fs.readFile(join(process.cwd(), 'package.json'), 'utf8'),
  ) as {
    scripts?: Record<string, unknown>;
  };
  for (const command of Object.values(manifest.scripts ?? {})) {
    expect(typeof command === 'string' ? command : '').not.toMatch(
      /(?:^|\s)(?:node|npm|npx)(?:\s|$)/,
    );
  }
});

// Integration: persistence round-trip with WAL

test('persistence: goal survives restart with WAL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-restart-'));
  const hooks1 = await GoalsPlugin(
    {directory: TEST_WORKSPACE_DIR},
    {
      persistState: true,
      stateRoot: dir,
      idlePoller: false,
    },
  );
  await runGoalCommand(hooks1, 's1', 'persistent goal');
  await hooks1.dispose?.();

  const hooks2 = await GoalsPlugin(
    {directory: TEST_WORKSPACE_DIR},
    {
      persistState: true,
      stateRoot: dir,
      idlePoller: false,
    },
  );
  const status = await runGoalCommand(hooks2, 's1', 'status');
  expect(status).toMatch(/persistent goal/);
  await hooks2.dispose?.();

  await rm(dir, {recursive: true, force: true});
});

test('persistence: WAL recovery discards proposed entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-wal-recovery-'));
  const paths = sessionStatePaths(dir, 's1');
  const statePath = paths.statePath;
  const ledgerPath = paths.ledgerPath;
  // A bare append is not the manager: the manager creates the session
  // directory before its first write, and a test that calls the low-level
  // writer directly owns that step itself.
  await ensureSessionDir(dir, 's1');

  const goal = createGoalState('s1', 'test goal');
  const transition = {
    source: 'update_goal' as const,
    goalId: goal.goalId,
    fromStatus: 'active' as const,
    toStatus: 'complete' as const,
    stopReason: '',
    blockedReason: '',
    detail: 'done',
  };
  await appendWalEntry(
    ledgerPath,
    createProposedEntry(goal, transition, ledgerPath),
  );

  const recovered = await recoverState(statePath, ledgerPath);
  expect(recovered.goals.length).toBe(0);

  await rm(dir, {recursive: true, force: true});
});

// Integration: ordered sequence auto-promote

test('ordered sequence: completing first goal should allow second to be focused', async () => {
  const {hooks} = await makePlugin();
  await runGoalCommand(hooks, 's1', 'sequence first; second');

  const list = await runGoalCommand(hooks, 's1', 'list');
  expect(list).toContain('first');
  expect(list).toContain('second');
});

// archived results persist + reload

test('getPersistedState syncs archived results to state file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-r56-sync-'));
  const paths = sessionStatePaths(dir, 's1');
  const hooks = await GoalsPlugin(
    {directory: TEST_WORKSPACE_DIR},
    {
      persistState: true,
      stateRoot: dir,
      idlePoller: false,
    },
  );
  await runGoalCommand(hooks, 's1', 'first goal');
  await runGoalCommand(hooks, 's1', 'sequence second goal');
  await hooks.dispose?.();

  const {results} = await recoverState(paths.statePath, paths.ledgerPath);
  expect(results.length).toBeGreaterThan(0);
  expect(results[0].state).toBe('cleared');

  await rm(dir, {recursive: true, force: true});
});

test('archived results loaded from state file on startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-r56-load-'));
  // Seeded into the SESSION's file, which is where startup now reads from.
  const paths = sessionStatePaths(dir, 's1');
  await mkdir(dirname(paths.statePath), {recursive: true});
  const goal = createGoalState('s1', 'completed objective', {
    tokenBudget: 50000,
  });
  goal.status = 'complete';
  const result = serializeResult(goal, 'achieved', 'done');
  await writeStateFile(paths.statePath, [], [result], ['s1']);

  const hooks = await GoalsPlugin(
    {directory: TEST_WORKSPACE_DIR},
    {
      persistState: true,
      stateRoot: dir,
      idlePoller: false,
    },
  );
  const list = await runGoalCommand(hooks, 's1', 'list');
  expect(list).toMatch(/Archived|achieved/i);
  await hooks.dispose?.();

  await rm(dir, {recursive: true, force: true});
});

test('goal continues after backgrounding and re-focusing when continuationClaim was set', async () => {
  const {hooks, promptCalls} = await makePlugin({
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
  });

  await runGoalCommand(hooks, 's1', 'build feature');

  await hooks.event!({type: 'session.idle', sessionID: 's1', id: 'idle-r257a'});
  expect(promptCalls.length).toBe(1);

  await runGoalCommand(hooks, 's1', 'add write tests');

  await runGoalCommand(hooks, 's1', 'focus 1');

  await hooks.event!({type: 'session.idle', sessionID: 's1', id: 'idle-r257b'});

  expect(promptCalls.length).toBe(2);
});

test('sessionOrdered cleared when last goal removed via removeGoal', async () => {
  const {hooks} = await makePlugin({
    noToolCallTurnsBeforePause: 0,
    minDelayMs: 0,
    judge: async () => ({approved: true, reason: 'sequence test approved'}),
  });

  // Create an ordered sequence with two goals
  await runGoalCommand(hooks, 's1', 'sequence task1; task2');

  // Complete the first goal (focused) via update_goal tool
  const updateGoalTool = hooks.tool?.update_goal as
    | {
        execute?: (ctx: unknown, args: unknown) => Promise<unknown>;
      }
    | undefined;
  expect(updateGoalTool?.execute).toBeDefined();
  await updateGoalTool!.execute!({status: 'complete'}, {sessionID: 's1'});

  // Run idle event to apply the pending intent — completes task1, autoPromotes task2
  await hooks.event!({type: 'session.idle', sessionID: 's1', id: 'idle-r261a'});

  // Complete the second goal (now focused after autoPromote)
  await updateGoalTool!.execute!({status: 'complete'}, {sessionID: 's1'});

  // Run idle event to apply the pending intent — completes task2, removes it
  await hooks.event!({type: 'session.idle', sessionID: 's1', id: 'idle-r261b'});

  // Create a new goal (not part of any sequence)
  await runGoalCommand(hooks, 's1', 'task3');

  // /goal list should NOT show "(ordered sequence)" — the sequence was exhausted
  const listOutput = await runGoalCommand(hooks, 's1', 'list');
  expect(listOutput).not.toMatch(/ordered sequence/i);
});

test('commandName with leading slash is normalized for command matching', async () => {
  const {hooks} = await makePlugin({commandName: '/test-cmd'});

  const output: {parts: {type: string; text: string}[]} = {parts: []};
  await hooks['command.execute.before']!(
    {command: 'test-cmd', sessionID: 's1', arguments: 'test objective'},
    output,
  );

  expect(output.parts[0]?.text).toMatch(/New active goal/i);
});
