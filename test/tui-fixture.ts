// tui-fixture.ts — write a companion-visible state file at the CURRENT path.
//
// A TUI companion reads `<stateRoot>/sessions/<sessionID>/state.json`. Every
// test that needs a goal on a companion's screen writes one, and they all used
// to write `<stateRoot>/state.json` because that was the only file there was.
// Leaving them pointing at the old path would make each of them a test that
// passes for the wrong reason — the companion would find nothing, and an
// assertion about the dashboard would be asserting on an empty store.
//
// The state root is a PARAMETER rather than a constant, because a companion
// resolves it the way the plugin does — this option, then FIXATE_ON_STATE_ROOT,
// then `.opencode/goals` — and a fixture that can only write the default one
// cannot express a configured-root case at all. Whenb added the
// configured-root gates, each suite grew its own private writer instead of
// changing this one, and the first gate written through the wrong fixture failed
// for exactly that reason. It is the one shared helper, so it is where the case
// belongs.
import {mkdir, writeFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

/** The default root, named once so a caller and this file cannot disagree. */
const DEFAULT_ROOT = ['.opencode', 'goals'] as const;

/**
 * Where one session's state file goes.
 *
 * `stateRoot` is the value a consumer would pass to the companion's `stateRoot`
 * option, relative to `directory` — the shape every caller here uses, and the one
 * the plugin's own `resolveWorkspacePath` produces for a relative option.
 *
 * An ABSOLUTE root is honoured as absolute rather than joined under
 * `directory`: `join("/ws", "/elsewhere")` yields `/ws/elsewhere`, so joining
 * would write the fixture to a path no caller asked for and silently make an
 * absolute-root case impossible to express in the one shared helper.
 */
function sessionStateDir(
  directory: string,
  sessionID: string,
  stateRoot?: string,
): string {
  if (!stateRoot)
    return join(directory, ...DEFAULT_ROOT, 'sessions', sessionID);
  return isAbsolute(stateRoot)
    ? join(stateRoot, 'sessions', sessionID)
    : join(directory, stateRoot, 'sessions', sessionID);
}

/** Write one session's state file under a workspace directory. */
export async function writeSessionState(
  directory: string,
  sessionID: string,
  state: unknown,
  stateRoot?: string,
): Promise<string> {
  const dir = sessionStateDir(directory, sessionID, stateRoot);
  await mkdir(dir, {recursive: true});
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, JSON.stringify(state), 'utf8');
  return statePath;
}

/** The same, for a caller that wants the path and writes raw text. */
export async function writeSessionStateText(
  directory: string,
  sessionID: string,
  body: string,
  stateRoot?: string,
): Promise<string> {
  const dir = sessionStateDir(directory, sessionID, stateRoot);
  await mkdir(dir, {recursive: true});
  const statePath = join(dir, 'state.json');
  await writeFile(statePath, body, 'utf8');
  return statePath;
}
