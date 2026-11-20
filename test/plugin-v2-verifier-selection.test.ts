import {expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setup} from '../src/plugin-v2.ts';
import type {V2AgentDraft} from '../src/plugin-v2-helpers.ts';

test('an unused built-in verifier does not disable a custom judge on a lazy agent transform', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fixate-custom-judge-'));
  try {
    for (const registerAgents of [true, false]) {
      for (const customJudge of [true, false]) {
        let transform!: (draft: V2AgentDraft) => void;
        const existing = {name: 'User verifier', mode: 'subagent'};
        const entries = new Map<string, Record<string, unknown>>([
          ['goal-verify', existing],
        ]);
        const dispose = await setup({
          app: {},
          location: {directory},
          options: {
            persistState: false,
            idlePoller: false,
            registerTools: false,
            registerCommand: false,
            registerAgents,
            logLevel: 'error',
            ...(customJudge
              ? {judge: async () => ({approved: true, reason: 'Custom check'})}
              : {}),
          },
          session: {
            prompt: async () => ({}),
            synthetic: async () => ({}),
            command: async () => ({}),
            create: async () => ({}),
            get: async () => ({}),
            interrupt: async () => ({}),
            generate: async () => ({}),
            hook: async () => ({dispose: async () => {}}),
          },
          event: {subscribe: async function* () {}},
          tool: {transform: async () => ({dispose: async () => {}})},
          command: {transform: async () => ({dispose: async () => {}})},
          agent: {
            transform: async callback => {
              // OpenCode materializes agent transforms after plugin setup.
              transform = callback;
              return {dispose: async () => {}};
            },
          },
        });
        try {
          const apply = () =>
            transform({
              get: id => entries.get(id),
              update: (id, edit) => {
                const entry = entries.get(id) ?? {};
                entries.set(id, entry);
                edit(entry);
              },
            });
          if (customJudge) {
            expect(apply).not.toThrow();
            expect(entries.get('goal-verify')).toBe(existing);
            expect(entries.has('goal')).toBe(registerAgents);
          } else {
            expect(apply).toThrow(/cannot safely use existing agent/);
          }
        } finally {
          await dispose();
        }
      }
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
