// goal-worker.ts — a SEPARATE PROCESS for the tests in test/two-processes-one-worktree.test.ts.
//
// It was a template literal in that file, which meant `tsc` never checked a line of
// it: a patch with undeclared bindings type-checked clean, because there was nothing
// to check. As a module it is ordinary TypeScript under the project's own compiler —
// and the moment it became one, seven type errors appeared in code that had never
// been compiled.
//
// Spawned as: bun run test/workers/goal-worker.ts <args...>, reporting one line of JSON.
import {GoalsPlugin} from '../../src/plugin.ts';

const [workspace, sessionID, createGoal] = process.argv.slice(2);

interface Report {
  sessionID: string;
  loaded: boolean;
  tools: string[];
  goalId?: string;
  error?: string;
}

const report: Report = {sessionID, loaded: false, tools: []};
try {
  const hooks = await GoalsPlugin(
    {directory: workspace},
    // NO stateRoot, so this exercises the DEFAULT root — the path a user gets
    // without configuring anything, which is the one the bug was reported on.
    {idlePoller: false, registerAgents: false},
  );
  report.loaded = true;
  report.tools = Object.keys(hooks.tool ?? {}).sort();
  const output = {parts: []};
  if (createGoal !== 'probe') {
    await hooks['command.execute.before']!(
      {
        command: 'goal',
        sessionID,
        arguments: 'work owned by ' + sessionID,
      },
      output,
    );
  }
  // A probe pass only shows the plugin LOADED; it creates nothing, so there
  // is no file to read and reading one would be the test's own error.
  if (createGoal !== 'probe') {
    const written = await Bun.file(
      workspace + '/.opencode/goals/sessions/' + sessionID + '/state.json',
    ).text();
    report.goalId = JSON.parse(written).goals[0]?.goalId;
  }
  await hooks.dispose?.();
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify(report));
