// identity-stub.ts — a deterministic, subprocess-free candidate-identity capture.
//
// The real `captureCandidateIdentity` shells `git` four times (two sequential
// pairs, each with its own 5s `execFile` timeout). That is correct in production
// and unusable in a test: how long an ambient `git` spawn takes is unbounded, so
// under load it raced bun's 5s per-test deadline and the suite flaked.
//
// This was first written inside test/hooks.test.ts. Standardising it here is the
// point (AGENTS.md, Kaizen): the same defect existed in EVERY suite that builds
// its own gate deps, and a fix left local is unfinished work. A suite that
// supplies gate deps should spread `STUB_IDENTITY_DEP` in.
//
// It preserves the two axes production distinguishes, because tests depend on
// the difference between them:
// - `candidate` is HEAD — stable across a working-tree edit, so a test that
// writes a file must NOT look like a new commit.
// - `fingerprint` is the working-tree content — it moves when a file changes.
// The temp workspaces these tests use are not git repositories, where the real
// capture yields `no-head` for HEAD and a directory digest for the fingerprint.
// This reads a directory the same way that fallback does (names, sizes, mtimes),
// so each test's premise is explicit instead of emergent from git behaviour.

import {createHash} from 'node:crypto';
import {mkdtempSync, readdirSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {CandidateIdentity} from '../src/completion-gate.ts';

export function stubIdentity(cwd: string): Promise<CandidateIdentity> {
  const hash = createHash('sha256');
  let entries: string[];
  try {
    entries = readdirSync(cwd).sort();
  } catch {
    return Promise.resolve({
      candidate: 'no-head',
      fingerprint: 'no-dir',
      freshnessUnknown: true,
    });
  }
  for (const entry of entries) {
    try {
      const info = statSync(join(cwd, entry));
      hash.update(`${entry}:${info.size}:${info.mtimeMs}\0`);
    } catch {
      hash.update(`${entry}:unreadable\0`);
    }
  }
  const fingerprint = hash.digest('hex').slice(0, 32);
  return Promise.resolve({candidate: 'no-head', fingerprint});
}

/**
 * Spread into a gate fixture so the capture never spawns a process:
 * const gate = {...STUB_IDENTITY_DEP, runVerifier, recoveryConfig }
 */
export const STUB_IDENTITY_DEP = {captureIdentity: stubIdentity} as const;

/**
 * A shared, empty workspace for plugin-level test suites.
 *
 * `GoalsPlugin` resolves its workspace from `context.directory ?? process.cwd`.
 * A suite that omits `directory` therefore runs its goals against the DEVELOPER'S
 * repository, and the completion gate's real `captureCandidateIdentity` shells
 * `git` four times per capture over it — unbounded work that races bun's 5s
 * per-test deadline under load. Measured: 4 of 20 loaded full-suite runs failed
 * on `` at 5000ms for exactly this reason, after the same defect had already
 * been fixed in two other suites.
 *
 * Passing this as `context.directory` makes the capture trivial. It is exported
 * rather than re-created per file so the fix cannot be left local again.
 */
export const TEST_WORKSPACE_DIR = mkdtempSync(
  join(tmpdir(), 'goal-test-workspace-'),
);
