// mutation-worker.ts — a SEPARATE PROCESS for the tests in test/refused-host-mutation.test.ts.
//
// It was a template literal in that file, which meant `tsc` never checked a line of
// it: a patch with undeclared bindings type-checked clean, because there was nothing
// to check. As a module it is ordinary TypeScript under the project's own compiler —
// and the moment it became one, seven type errors appeared in code that had never
// been compiled.
//
// Spawned as: bun run test/workers/mutation-worker.ts <args...>, reporting one line of JSON.
import {GoalsPlugin} from '../../src/plugin.ts';

const [workspace, sessionID, deliverCompaction, readyFile, goFile] =
  process.argv.slice(2);
const reported: string[] = [];
const originalError = console.error;
console.error = (...args) => {
  reported.push(args.join(' '));
  originalError(...args);
};
const hooks = await GoalsPlugin(
  {
    directory: workspace,
    client: {
      app: {
        log: async () => {},
      },
      session: {
        messages: async () => ({data: []}),
        promptAsync: async () => ({}),
      },
    },
  },
  {idlePoller: false, registerAgents: false},
);
// The refusal is recorded during startup hydration, before any event is handled.
if (deliverCompaction === 'yes') {
  await hooks.event?.({type: 'session.compacted', sessionID, properties: {}});
}
await new Promise(r => setTimeout(r, 150));
await Bun.write(readyFile, 'ready');

const deadline = Date.now() + 20000;
while (!(await Bun.file(goFile).exists()) && Date.now() < deadline) {
  await new Promise(r => setTimeout(r, 25));
}
await new Promise(r => setTimeout(r, 100));
const output = {parts: [] as unknown[]};
await hooks['command.execute.before']!(
  {command: 'goal', sessionID, arguments: 'checkpoint a note'},
  output,
);
process.stdout.write(
  JSON.stringify({
    refusals: reported.filter(l => l.includes('already owned')).length,
    said: output.parts
      .map(p => String((p as {text?: string}).text ?? ''))
      .join('\\n')
      .split('\\n')[0],
  }),
);
await hooks.dispose?.();
