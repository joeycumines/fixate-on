// retry-worker.ts — a SEPARATE PROCESS for the tests in test/two-processes-one-worktree.test.ts.
//
// It was a template literal in that file, which meant `tsc` never checked a line of
// it: a patch with undeclared bindings type-checked clean, because there was nothing
// to check. As a module it is ordinary TypeScript under the project's own compiler —
// and the moment it became one, seven type errors appeared in code that had never
// been compiled.
//
// Spawned as: bun run test/workers/retry-worker.ts <args...>, reporting one line of JSON.
import {GoalsPlugin} from '../../src/plugin.ts';

const workspace = process.argv[2];
const statePath = workspace + '/.opencode/goals/sessions/ses_retry/state.json';
const hooks = await GoalsPlugin(
  {directory: workspace},
  {idlePoller: false, registerAgents: false},
);
const output = {parts: [] as unknown[]};
await hooks['command.execute.before']!(
  {
    command: 'goal',
    sessionID: 'ses_retry',
    arguments: 'work in the session',
  },
  output,
);
// What matters is whether the SESSION'S FILE exists, not whether the command
// returned: a goal that works in memory while its state is never written is
// exactly the failure, and a command that returns successfully is not evidence
// either way.
process.stdout.write(
  (await Bun.file(statePath).exists()) ? 'WROTE' : 'NOT-WRITTEN',
);
await hooks.dispose?.();
