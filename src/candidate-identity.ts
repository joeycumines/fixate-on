/**
 * Working-tree identity computation: git HEAD plus a bounded digest
 * (up to 64 MiB diff and 512 untracked files) of the working tree.
 * Truncated captures are marked freshnessUnknown and cannot satisfy completion.
 */

import {createHash} from 'node:crypto';
import {lstat, open} from 'node:fs/promises';
import {runBounded} from './bounded-spawn.ts';

export interface CandidateIdentity {
  /** Short SHA of git HEAD, or "no-head:<digest>" fallback. */
  candidate: string;
  /** SHA-256 fingerprint of the complete tracked and untracked working-tree state. */
  fingerprint: string;
  /** True only when every bounded identity input was captured completely. */
  freshnessUnknown?: boolean;
}

// Bounded limits for working tree diffs and untracked file inspection.
const GIT_DIFF_MAX_BYTES = 64 * 1_048_576;
const MAX_UNTRACKED_IDENTITY_FILES = 512;
const MAX_UNTRACKED_IDENTITY_BYTES = GIT_DIFF_MAX_BYTES;

function unknownIdentity(candidate: string, reason: string): CandidateIdentity {
  return {
    candidate,
    fingerprint: `freshness-unknown:${reason}`,
    freshnessUnknown: true,
  };
}

function pathIsDependencyTree(relativePath: string): boolean {
  return (
    relativePath === 'node_modules' ||
    relativePath.startsWith('node_modules/') ||
    relativePath === '.git' ||
    relativePath.startsWith('.git/') ||
    relativePath.includes('/node_modules/') ||
    relativePath.includes('/.git/')
  );
}

function pathIsEphemeralRuntimeTree(relativePath: string): boolean {
  return (
    relativePath === '.claude' ||
    relativePath.startsWith('.claude/') ||
    relativePath === '.opencode' ||
    relativePath.startsWith('.opencode/') ||
    relativePath === '.omo' ||
    relativePath.startsWith('.omo/') ||
    relativePath === '.osm' ||
    relativePath.startsWith('.osm/') ||
    relativePath === '.idea' ||
    relativePath.startsWith('.idea/') ||
    relativePath === 'scratch' ||
    relativePath.startsWith('scratch/') ||
    relativePath.startsWith('scripts/live-probe/') ||
    relativePath === '.playwright-mcp' ||
    relativePath.startsWith('.playwright-mcp/')
  );
}

function boundedIdentityPaths(output: string): string[] | null {
  const paths = [...new Set(output.split('\0').filter(Boolean))]
    .filter(
      path => !pathIsDependencyTree(path) && !pathIsEphemeralRuntimeTree(path),
    )
    .sort();
  return paths.length > MAX_UNTRACKED_IDENTITY_FILES ? null : paths;
}

/**
 * Determine whether a fingerprint indicates an incomplete or unknown capture state
 * rather than a valid content hash.
 */
export function isFreshnessUnknownFingerprint(
  fingerprint: string | null | undefined,
): boolean {
  if (typeof fingerprint !== 'string') return true;
  const trimmed = fingerprint.trim();
  return (
    trimmed.length === 0 ||
    trimmed === 'unknown' ||
    trimmed.startsWith('freshness-unknown:')
  );
}

/**
 * Capture candidate identity from the working tree at cwd.
 */
export async function captureCandidateIdentity(
  cwd: string,
): Promise<CandidateIdentity> {
  const head = await runBounded(
    'git',
    ['rev-parse', '--short', 'HEAD'],
    cwd,
    5000,
    4096,
  );
  const candidate = head.ok ? head.stdout.trim() || 'no-head' : 'no-head';

  // Capture diff against HEAD. Untracked and ignored build artifacts are listed
  // separately so verifier outputs or ignored artifacts are tracked, while dependency
  // and VCS directories are excluded.
  const diff = await runBounded(
    'git',
    ['diff', 'HEAD'],
    cwd,
    5000,
    GIT_DIFF_MAX_BYTES,
  );
  const pathspecExclusions = [':!**/node_modules/**', ':!**/.git/**'];
  const untrackedArgs = [
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...pathspecExclusions,
  ];
  const ignoredArgs = [
    '--others',
    '--ignored',
    '--exclude-standard',
    '-z',
    '--',
    ...pathspecExclusions,
  ];
  const [untracked, ignored] = await Promise.all([
    runBounded(
      'git',
      ['ls-files', ...untrackedArgs],
      cwd,
      5000,
      GIT_DIFF_MAX_BYTES,
    ),
    runBounded(
      'git',
      ['ls-files', ...ignoredArgs],
      cwd,
      5000,
      GIT_DIFF_MAX_BYTES,
    ),
  ]);
  const untrackedOutput = [untracked.stdout, ignored.stdout]
    .filter(Boolean)
    .join('\0');
  const untrackedTruncated = untracked.truncated || ignored.truncated;

  // Partial diffs or truncated listings cannot establish freshness; mark unusable
  // to avoid false positives in equality checks.
  if (diff.truncated || untrackedTruncated) {
    return unknownIdentity(
      candidate,
      diff.truncated ? 'tracked-diff' : 'untracked-list',
    );
  }
  let fingerprint: string;
  if (diff.stdout || untrackedOutput) {
    const hash = createHash('sha256');
    hash.update(diff.stdout);
    const paths = boundedIdentityPaths(untrackedOutput);
    if (!paths) return unknownIdentity(candidate, 'untracked-count');
    let untrackedIdentityUnknown = false;
    let untrackedBytes = 0;
    for (const relativePath of paths) {
      if (untrackedBytes > MAX_UNTRACKED_IDENTITY_BYTES) {
        untrackedIdentityUnknown = true;
        hash.update('<untracked-byte-limit>');
        break;
      }
      hash.update('\0' + relativePath);

      try {
        const path = `${cwd}/${relativePath}`;
        const info = await lstat(path);
        const maxUntrackedBytes = GIT_DIFF_MAX_BYTES;
        if (
          !info.isFile() ||
          info.size > maxUntrackedBytes ||
          untrackedBytes + info.size > MAX_UNTRACKED_IDENTITY_BYTES
        ) {
          hash.update('<unreadable-or-oversized>');
          untrackedIdentityUnknown = true;
          continue;
        }
        untrackedBytes += info.size;
        const handle = await open(path, 'r');
        try {
          const buffer = Buffer.allocUnsafe(info.size);
          const readResult = await handle.read(buffer, 0, info.size, 0);
          if (readResult.bytesRead !== info.size) {
            untrackedIdentityUnknown = true;
            hash.update(`<short-read:${readResult.bytesRead}/${info.size}>`);
          } else {
            hash.update(buffer);
          }
        } finally {
          await handle.close();
        }
      } catch {
        hash.update('<unreadable>');
        untrackedIdentityUnknown = true;
      }
    }
    if (untrackedIdentityUnknown) {
      return {
        candidate,
        fingerprint: `freshness-unknown:${hash.digest('hex').slice(0, 24)}`,
        freshnessUnknown: true,
      };
    }
    fingerprint = hash.digest('hex').slice(0, 32);
  } else {
    fingerprint = await directoryDigest(cwd);
  }
  return {candidate, fingerprint};
}

/**
 * Best-effort fallback when git is unavailable. Hashes file names, sizes, and mtimes.
 * File contents are not read.
 */
async function directoryDigest(cwd: string): Promise<string> {
  const {readdir, stat} = await import('node:fs/promises');
  const hash = createHash('sha256');
  try {
    const entries = await readdir(cwd, {withFileTypes: true});
    // Sort deterministically to avoid spurious differences across file systems.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      hash.update(entry.name);
      try {
        const s = await stat(`${cwd}/${entry.name}`);
        hash.update(String(s.mtimeMs));
        if (entry.isFile()) hash.update(String(s.size));
      } catch {
        // Skip unreadable or concurrently deleted files.
      }
    }
  } catch {
    hash.update('unreadable');
  }
  return hash.digest('hex').slice(0, 32);
}
