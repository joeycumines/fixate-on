// drive-worker.ts — a SEPARATE PROCESS for the tests in test/two-processes-one-worktree.test.ts.
//
// It was a template literal in that file, which meant `tsc` never checked a line of
// it: a patch with undeclared bindings type-checked clean, because there was nothing
// to check. As a module it is ordinary TypeScript under the project's own compiler —
// and the moment it became one, seven type errors appeared in code that had never
// been compiled.
//
// Spawned as: bun run test/workers/drive-worker.ts <args...>, reporting one line of JSON.
import {GoalsPlugin} from '../../src/plugin.ts';

const [workspace, sessionID] = process.argv.slice(2);
const prompts: string[] = [];
const hooks = await GoalsPlugin(
  {
    directory: workspace,
    client: {
      app: {
        log: async () => {},
      },
      session: {
        messages: async () => ({
          data: [
            {
              id: 'm1',
              info: {role: 'assistant', time: {completed: 1}, finish: 'stop'},
              parts: [],
            },
          ],
        }),
        // A host that ANSWERS for the foreign session, which is what turns a
        // stray prompt into a runaway: a refused host that never gets an answer
        // would stop after one attempt and look healthy.
        promptAsync: async (sid: string) => {
          prompts.push(sid);
          return {};
        },
      },
    },
  },
  {
    idlePoller: true,
    idlePollerIntervalMs: 20,
    idleQuietMs: 5,
    registerAgents: false,
  },
);
// Two idles, which is what a host with no authentic idle events gets from the
// poller. The recovery re-arm is the thing under test.
await hooks.event?.({
  type: 'session.idle',
  sessionID,
  id: 'probe-idle-1',
} as never);
await hooks.event?.({
  type: 'session.idle',
  sessionID,
  id: 'probe-idle-2',
} as never);
// 2500 ms, not the 250 ms this used to wait, and the reason is a rule this
// repository has already been bitten by twice (see the kickoff note in
// plugin-runtime.ts and test/kickoff-refusal.test.ts): a gate that only holds
// inside a window shorter than the thing it measures is not a gate. 2500 is the
// plugin's own longest event-to-prompt delay, so the window covers it. MEASURED
// both ways at 3000 ms — with the gate the worker stays silent, and with
// canDriveSession neutered this still fails on "must not send continuation
// prompts".
await new Promise(r => setTimeout(r, 2500));
const statePath =
  workspace + '/.opencode/goals/sessions/' + sessionID + '/state.json';
// The CONTENT, not the existence: the harness seeds that file itself, so "does it
// exist" is true before this worker has done anything at all. A first version of
// this assertion used exists and reported the product writing when the fixture
// had simply created the file.
const state = await Bun.file(statePath).text();
process.stdout.write(JSON.stringify({prompts, state}));
await hooks.dispose?.();
