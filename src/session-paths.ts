/**
 * Goal state disk layout and containment validation:
 * <stateRoot>/sessions/<sessionID>/state.json (+.ledger.jsonl, +.1.2.3)
 *
 * Per-session files keep each session's counter, rotation window, and
 * snapshot disjoint. The session ID is host input, so it is strictly
 * validated (allowlist plus length bound) and never rewritten.
 */

import {lstatSync} from 'node:fs';
import {dirname, join, relative, resolve, sep} from 'node:path';

/** The directory under a state root that holds one subdirectory per session. */
export const SESSIONS_DIRNAME = 'sessions';

/**
 * Default directory where goal state is stored. Kept as a directory to isolate
 * per-session state and maintain backward compatibility with existing files on disk.
 */
export const DEFAULT_STATE_ROOT = '.opencode/goals';

/** The snapshot filename inside a session's directory. */
export const STATE_FILENAME = 'state.json';

/** Ledger suffix appended to the snapshot filename. Rotated generations append `.1`, `.2`, etc. */
export const LEDGER_SUFFIX = '.ledger.jsonl';

/**
 * Character allowlist and length limit for session IDs.
 * Restricts path separators across platforms and prevents ENAMETOOLONG errors.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Validate a host-supplied session ID for use as a directory name.
 *
 * @returns The session ID unchanged if valid.
 * @throws Error naming the truncated offending value if invalid.
 */
export function assertSafeSessionID(sessionID: string): string {
  if (typeof sessionID !== 'string' || !SESSION_ID_PATTERN.test(sessionID)) {
    const shown =
      typeof sessionID === 'string'
        ? sessionID.slice(0, 64)
        : String(sessionID);
    throw new Error(
      `refusing to use ${JSON.stringify(shown)} as a session directory name: a session id must be 1-128 characters of A-Z, a-z, 0-9, '_' or '-'`,
    );
  }
  return sessionID;
}

export interface SessionStatePaths {
  /** The session's snapshot file. */
  statePath: string;
  /** The session's WAL ledger. */
  ledgerPath: string;
  /** The session's directory, which also contains rotated ledger generations. */
  sessionDir: string;
}

/**
 * Computes the directory and state file paths for a given session.
 */
export function sessionStatePaths(
  stateRoot: string,
  sessionID: string,
): SessionStatePaths {
  const sessionDir = join(
    stateRoot,
    SESSIONS_DIRNAME,
    assertSafeSessionID(sessionID),
  );
  const statePath = join(sessionDir, STATE_FILENAME);
  return {sessionDir, statePath, ledgerPath: `${statePath}${LEDGER_SUFFIX}`};
}

/**
 * Ensures a target path does not escape the state root boundary and does not
 * traverse any symlinked segments.
 *
 * Symlink traversal is rejected to ensure writes cannot escape into arbitrary
 * locations on the filesystem. Every segment from root to leaf is validated.
 */
export function assertContainedInStateRoot(
  stateRoot: string,
  target: string,
): void {
  // Normalize once to prevent trailing slashes from breaking dirname() and lstatSync().
  const root = resolve(stateRoot);
  const rel = relative(root, target);
  if (rel.startsWith('..')) {
    throw new Error(
      `goal persistence path escapes the state root and is refused: ${target}`,
    );
  }

  // Verify the root boundary segment itself is not a symlink. Higher workspace
  // segments are governed by the workspace loader.
  const rootParent = dirname(root);
  if (root !== rootParent) {
    let rootIsSymlink = false;
    try {
      rootIsSymlink = lstatSync(root).isSymbolicLink();
    } catch {
      // Missing or unreadable paths are not symlinks; let the write operation surface I/O errors.
    }
    if (rootIsSymlink) {
      throw new Error(
        `refusing goal persistence: the state root itself is a symlink (${root}), so goal state would ` +
          'be written outside it. Point `stateRoot` at a real directory.',
      );
    }
  }
  if (rel === '') return;

  let cursor = root;
  for (const segment of rel.split(sep).filter(s => s.length > 0)) {
    cursor = join(cursor, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(cursor);
    } catch {
      // Non-existent segment terminates the walk since nothing can exist beneath it.
      break;
    }
    if (info.isSymbolicLink()) {
      throw new Error(
        `refusing goal persistence through a symlinked path segment: ${cursor}`,
      );
    }
  }
}

/**
 * Creates a session directory recursively if it does not already exist.
 *
 * Runs the containment guard prior to directory creation to prevent following
 * symlinked directories on write.
 */
export async function ensureSessionDir(
  stateRoot: string,
  sessionID: string,
): Promise<string> {
  const {mkdir} = await import('node:fs/promises');
  const {sessionDir} = sessionStatePaths(stateRoot, sessionID);
  assertContainedInStateRoot(stateRoot, sessionDir);
  await mkdir(sessionDir, {recursive: true, mode: 0o700});
  return sessionDir;
}

/**
 * Lists all valid session IDs present under the state root.
 *
 * Unreadable directories are ignored to prevent one corrupted session from
 * blocking startup recovery for other sessions. Results are sorted deterministically.
 */
export async function listSessionIDs(stateRoot: string): Promise<string[]> {
  let entries: Array<{name: string; isDirectory: () => boolean}>;
  try {
    const {readdir} = await import('node:fs/promises');
    entries = await readdir(join(stateRoot, SESSIONS_DIRNAME), {
      withFileTypes: true,
    });
  } catch {
    // Return empty list if the workspace has never initialized or stored goals.
    return [];
  }
  return entries
    .filter(entry => entry.isDirectory() && SESSION_ID_PATTERN.test(entry.name))
    .map(entry => entry.name)
    .sort();
}
