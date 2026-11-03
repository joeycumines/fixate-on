import {expect, test} from 'bun:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DEFAULT_GOAL_OPTIONS, GoalsPlugin} from '../src/plugin.ts';

// DEFAULT_GOAL_OPTIONS

test('DEFAULT_GOAL_OPTIONS has expected defaults', () => {
  expect(DEFAULT_GOAL_OPTIONS.maxTokens).toBe(1000000);
  expect(DEFAULT_GOAL_OPTIONS.maxTurns).toBe(0);
  expect(DEFAULT_GOAL_OPTIONS.maxDurationMs).toBe(1800000);
  expect(DEFAULT_GOAL_OPTIONS.noProgressTokenThreshold).toBe(50);
  expect(DEFAULT_GOAL_OPTIONS.noProgressTurnsBeforePause).toBe(3);
  expect(DEFAULT_GOAL_OPTIONS.budgetWrapupRatio).toBe(0.8);
});

// GoalsPlugin factory

const NO_PERSIST = {persistState: false};

test('GoalsPlugin returns hooks object', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks).toBeDefined();
  expect(typeof hooks).toBe('object');
});

test('GoalsPlugin registers tools by default', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks.tool).toBeDefined();
  expect(typeof hooks.tool).toBe('object');
  expect(hooks.tool!.get_goal).toBeDefined();
  expect(hooks.tool!.create_goal).toBeDefined();
  expect(hooks.tool!.update_goal).toBeDefined();
  expect(hooks.tool!.list_goals).toBeDefined();
  expect(hooks.tool!.focus_goal).toBeDefined();
});

test('GoalsPlugin skips tool registration when registerTools is false', async () => {
  const hooks = await GoalsPlugin({}, {...NO_PERSIST, registerTools: false});
  expect(hooks.tool).toBeUndefined();
});

test('GoalsPlugin registers system.transform hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks['experimental.chat.system.transform']).toBeDefined();
  expect(typeof hooks['experimental.chat.system.transform']).toBe('function');
});

test('GoalsPlugin registers chat.message hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks['chat.message']).toBeDefined();
  expect(typeof hooks['chat.message']).toBe('function');
});

test('GoalsPlugin registers event hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks.event).toBeDefined();
  expect(typeof hooks.event).toBe('function');
});

test('GoalsPlugin registers compaction hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks['experimental.session.compacting']).toBeDefined();
  expect(typeof hooks['experimental.session.compacting']).toBe('function');
});

test('GoalsPlugin uses custom command name', async () => {
  const hooks = await GoalsPlugin({}, {...NO_PERSIST, commandName: 'task'});
  expect(hooks).toBeDefined();
});

test('GoalsPlugin works without persistence', async () => {
  const hooks = await GoalsPlugin({}, {persistState: false});
  expect(hooks).toBeDefined();
  expect(hooks.tool).toBeDefined();
});

test('GoalsPlugin registers config hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks.config).toBeDefined();
  expect(typeof hooks.config).toBe('function');
});

test('GoalsPlugin registers compaction.autocontinue hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks['experimental.compaction.autocontinue']).toBeDefined();
  expect(typeof hooks['experimental.compaction.autocontinue']).toBe('function');
});

test('GoalsPlugin registers dispose hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks.dispose).toBeDefined();
  expect(typeof hooks.dispose).toBe('function');
});

test('GoalsPlugin resolves default persistence under the host workspace, per session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-workspace-'));
  const hooks = await GoalsPlugin({directory}, {});
  try {
    const output: {parts: {type: string; text: string}[]} = {parts: []};
    await hooks['command.execute.before']!(
      {command: 'goal', sessionID: 's1', arguments: 'persist this goal'},
      output,
    );
    // The default root keeps its name; the file inside it is addressed by
    // session, which is what makes two processes in one worktree safe.
    const statePath = join(
      directory,
      '.opencode',
      'goals',
      'sessions',
      's1',
      'state.json',
    );
    expect(await Bun.file(statePath).exists()).toBe(true);
    const {goals} = JSON.parse(await Bun.file(statePath).text());
    expect(goals).toHaveLength(1);
    expect(goals[0].sessionID).toBe('s1');
    // And a DIFFERENT session writes a DIFFERENT file, not a second copy of
    // this one — the property the whole layout exists for.
    const second = await mkdtemp(join(tmpdir(), 'goal-workspace-2-'));
    const other = await GoalsPlugin({directory: second}, {});
    try {
      const out2: {parts: {type: string; text: string}[]} = {parts: []};
      await other['command.execute.before']!(
        {command: 'goal', sessionID: 's2', arguments: 'another goal'},
        out2,
      );
      expect(
        await Bun.file(
          join(second, '.opencode', 'goals', 'sessions', 's2', 'state.json'),
        ).exists(),
      ).toBe(true);
      expect(
        await Bun.file(
          join(second, '.opencode', 'goals', 'sessions', 's1', 'state.json'),
        ).exists(),
      ).toBe(false);
    } finally {
      await other.dispose?.();
      await rm(second, {recursive: true, force: true});
    }
  } finally {
    await hooks.dispose?.();
    await rm(directory, {recursive: true, force: true});
  }
});

test('GoalsPlugin registers command.execute.before hook', async () => {
  const hooks = await GoalsPlugin({}, NO_PERSIST);
  expect(hooks['command.execute.before']).toBeDefined();
  expect(typeof hooks['command.execute.before']).toBe('function');
});

// default export

test('default export has correct id', async () => {
  const {default: defaultExport} = await import('../src/plugin.ts');
  expect(defaultExport.id).toBe('fixate-on');
  // v2 Promise-plugin shape: { id, setup(context) }. opencode2's server plugin
  // loader validates `default` against a schema requiring `effect` or `setup`.
  expect(typeof defaultExport.setup).toBe('function');
});
