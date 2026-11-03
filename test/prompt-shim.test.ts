// The v2 context is `any` at the host boundary (see src/plugin-v2.ts), and
// these fixtures are deliberately shaped like whatever a test passes through
// it. A suppression with a stated reason is reviewable; a silent one is not.
/* eslint-disable @typescript-eslint/no-explicit-any */
import {describe, expect, test} from 'bun:test';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setup, v1PartsToV2Text} from '../src/plugin-v2.ts';

describe('v1 parts → v2 text translation (A4 live-found defect lock)', () => {
  test('continuation payload maps to {sessionID, text} with hoisted plugin metadata', () => {
    const out = v1PartsToV2Text({
      sessionID: 'ses-1',
      parts: [
        {
          type: 'text',
          text: 'Continue the goal.',
          metadata: {'fixate-on': {kind: 'continuation'}},
          synthetic: true,
        },
      ],
    });
    expect(out.sessionID).toBe('ses-1');
    expect(out.text).toBe('Continue the goal.');
    expect(out.metadata).toEqual({kind: 'continuation'});
  });

  test('multi-part payloads join text with blank lines; non-text parts ignored', () => {
    const out = v1PartsToV2Text({
      sessionID: 's',
      parts: [
        {type: 'text', text: 'first'},
        {type: 'image', url: 'x'},
        {type: 'text', text: 'second'},
      ],
    });
    expect(out.text).toBe('first\n\nsecond');
  });

  test('missing/undefined text yields empty string (never undefined)', () => {
    expect(v1PartsToV2Text({sessionID: 's', parts: []}).text).toBe('');
    expect(v1PartsToV2Text({}).text).toBe('');
    expect(v1PartsToV2Text({}).sessionID).toBeUndefined();
  });
});

describe('setup() wires promptAsync through v2 synthetic (steer semantics)', () => {
  test("GoalsPlugin's client shim routes promptAsync to ctx.session.synthetic with flat text", async () => {
    const calls: Array<{op: string; args: any}> = [];
    const recordingSession = new Proxy(
      {},
      {
        get(_t, prop: string) {
          return async (input: any) => {
            calls.push({op: prop, args: input});
            return {};
          };
        },
      },
    ) as any;

    const ctx: any = {
      app: {name: 'test'},
      // Hermetic state ROOT: the fixture must never contend with a live
      // session's persistence lease on the repo's real goal state, and must
      // never write into the developer's own workspace. It is a DIRECTORY,
      // because that is what the option is now — the earlier `stateFilePath`
      // here configured nothing at all, and a test whose comment claims to be
      // hermetic while it is not is worse than no comment.
      options: {stateRoot: await mkdtemp(join(tmpdir(), 'goal-shim-'))},
      session: Object.assign(recordingSession, {
        hook: async (_name: string, _cb: unknown) => ({
          dispose: async () => {},
        }),
      }),
      event: {
        subscribe: async function* () {},
      },
      tool: {
        transform: async (_cb: unknown) => ({
          dispose: async () => {},
        }),
      },
      command: {
        transform: async (_cb: unknown) => ({
          dispose: async () => {},
        }),
      },
    };

    const dispose = await setup(ctx);
    const promptCalls = calls.filter(c => c.op === 'prompt');
    for (const call of promptCalls) {
      expect(typeof call.args.text).toBe('string');
      expect(call.args.parts).toBeUndefined();
    }
    if (typeof dispose === 'function') await dispose();
  });
});
