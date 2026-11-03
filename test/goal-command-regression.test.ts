// goal-command-regression.test.ts — LOCKS the goal-command tool's registration
// on BOTH host paths so a future change cannot silently drop it (the reported
// "model cannot find the goal-command tool" regression class).
//
// Contract-Over-Green: these tests fail if the v1 hooks.tool OR the v2
// Bridge-3 tool.transform no longer registers `goal-command`. They are
// verification locks, not fixtures.
import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {GoalsPlugin} from '../src/plugin-runtime.ts';
import pluginDefault from '../src/plugin.ts';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gc-regression-'));
}

describe('goal-command tool registration regression lock', () => {
  test('v1: hooks.tool includes goal-command alongside the goal tools', async () => {
    const dir = tmpdir();
    try {
      const hooks = (await GoalsPlugin(
        {client: {}, directory: dir},
        {
          persistState: false,
          goalAgentName: 'goal',
          verifierAgentName: 'goal-verify',
        },
      )) as unknown as {tool?: Record<string, unknown>};
      expect(hooks.tool).toBeDefined();
      const names = Object.keys(hooks.tool!);
      expect(names).toContain('goal-command');
      expect(names).toContain('create_goal');
      expect(names).toContain('update_goal');
      expect(names).toContain('get_goal');
      expect(names).toContain('list_goals');
      expect(names).toContain('focus_goal');
      expect(names).toContain('propose_goal_change');
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('v2: Bridge-3 registers goal-command via ctx.tool.transform', async () => {
    const added: Array<{name: string}> = [];
    type AddInfo = {
      name: string;
      description: string;
      input: unknown;
      execute: (...a: unknown[]) => unknown;
    };
    // A genuine async generator: setup's event bridge consumes
    // ctx.event.subscribe with for-await; a bare Promise would only work by
    // relying on the adapter's internal catch swallowing the TypeError.
    async function* emptyEventStream() {}

    const ctx: unknown = {
      app: {name: 'test', version: '0', channel: 'test'},
      // persistState:false is REQUIRED: setup falls back to process.cwd as
      // its directory, so with persistence on this test would acquire the
      // repo's REAL persistence lease under <repo>/.opencode/goals/ and leak
      // stale locks — the exact hazard documented in
      // plugin-v2-tool-schema.test.ts (which sets the same option).
      options: {persistState: false},
      session: {
        prompt: async () => ({}),
        synthetic: async () => ({}),
        command: async () => ({}),
        create: async () => ({}),
        get: async () => ({}),
        interrupt: async () => ({}),
        generate: async () => ({}),
        hook: async () => ({
          dispose: async () => {},
        }),
      },
      event: {subscribe: emptyEventStream},
      tool: {
        transform: async (
          cb: (draft: {add: (info: AddInfo) => void}) => void,
        ) => {
          cb({
            add: (info: AddInfo) => {
              added.push(info);
            },
          });
          return {
            dispose: async () => {},
          };
        },
      },
      command: {
        transform: async () => ({
          dispose: async () => {},
        }),
      },
    };
    // setup resolves to a BARE async cleanup function
    // (Promise< => Promise<void>>) — NOT a {dispose} object. Cast it as such
    // and invoke it in finally so v2 registrations and the runtime dispose
    // always run (a {dispose?} read on a function is undefined: silent no-op).
    const setup = pluginDefault.setup as (
      c: unknown,
    ) => Promise<() => Promise<void>>;
    const dispose = await setup(ctx);
    try {
      const gc = added.find(a => a.name === 'goal-command');
      expect(gc).toBeDefined();
      // Every surveyed tool is registered exactly once (none missing, no dupes).
      const names = added.map(a => a.name);
      for (const required of [
        'goal-command',
        'create_goal',
        'update_goal',
        'get_goal',
        'list_goals',
        'focus_goal',
        'propose_goal_change',
      ]) {
        expect(names.filter(n => n === required).length).toBe(1);
      }
    } finally {
      await dispose();
    }
  });

  test('v1: goal-command tool executes the status subcommand end-to-end', async () => {
    const dir = tmpdir();
    try {
      const hooks = (await GoalsPlugin(
        {client: {}, directory: dir},
        {
          persistState: false,
          goalAgentName: 'goal',
          verifierAgentName: 'goal-verify',
        },
      )) as unknown as {tool?: Record<string, unknown>};
      const gc = hooks.tool!['goal-command'] as unknown as {
        execute: (
          a: Record<string, unknown>,
          c: {sessionID: string},
        ) => Promise<unknown>;
      };
      expect(typeof gc.execute).toBe('function');
      const out = await gc.execute(
        {subcommand: 'status'},
        {sessionID: 'sess-gc-lock'},
      );
      // Status on a fresh session renders a human-readable report: never
      // undefined/null, never an empty payload.
      const rendered =
        typeof out === 'string' ? out : JSON.stringify(out ?? '');
      expect(rendered.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });

  test('goal-command tool replaces an existing goal end-to-end (v1 path)', async () => {
    const dir = tmpdir();
    try {
      const hooks = (await GoalsPlugin(
        {client: {}, directory: dir},
        {
          persistState: false,
          goalAgentName: 'goal',
          verifierAgentName: 'goal-verify',
          kickoffDelayMs: 999999,
        },
      )) as unknown as {
        tool?: Record<string, unknown>;
        dispose?: () => Promise<void>;
      };
      const gc = hooks.tool!['goal-command'] as unknown as {
        execute: (
          a: Record<string, unknown>,
          c: {sessionID: string},
        ) => Promise<unknown>;
      };
      const sid = 'sess-replace-e2e';
      // Create the first goal
      const out1 = await gc.execute(
        {subcommand: 'First objective'},
        {sessionID: sid},
      );
      const r1 = typeof out1 === 'string' ? out1 : JSON.stringify(out1 ?? '');
      expect(r1).toContain('New active goal: First objective');
      // Replace it with a second goal — must succeed without error
      const out2 = await gc.execute(
        {subcommand: 'Second objective'},
        {sessionID: sid},
      );
      const r2 = typeof out2 === 'string' ? out2 : JSON.stringify(out2 ?? '');
      expect(r2).toContain('New active goal: Second objective');
      expect(r2).not.toContain('unfinished goal');
      expect(r2).not.toContain('Cannot create');
      // Status confirms only the replacement is live
      const out3 = await gc.execute({subcommand: 'status'}, {sessionID: sid});
      const r3 = typeof out3 === 'string' ? out3 : JSON.stringify(out3 ?? '');
      expect(r3).toContain('Second objective');
      expect(r3).not.toContain('First objective');
      if (hooks.dispose) await hooks.dispose();
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
