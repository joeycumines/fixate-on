/**
 * Provides a mkdir-based mutex per session state file so that processes
 * contend only when writing to the same session. Stale locks from terminated
 * processes on the same host are automatically reclaimed.
 */

import {randomUUID} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {hostname} from 'node:os';
import {dirname} from 'node:path';

export interface LeaseOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

export interface PersistenceLease {
  lockPath: string;
  owner: LeaseOwner;
  release: () => Promise<boolean>;
}

export interface AcquireLeaseOptions {
  malformedGraceMs?: number;
  now?: () => number;
}

const LOCAL_HOSTNAME_SUFFIXES = ['.local', '.lan', '.home', '.localdomain'];

/**
 * Canonicalizes a hostname for same-host comparison by lowercasing and stripping
 * common trailing local suffixes while preserving multi-label domain names.
 */
export function canonicalizeHostname(hostname: string): string {
  if (typeof hostname !== 'string') return '';
  const trimmed = hostname.trim().toLowerCase();
  if (trimmed === '') return '';
  const firstDot = trimmed.indexOf('.');
  if (firstDot <= 0) return trimmed;
  const tail = trimmed.slice(firstDot);
  return LOCAL_HOSTNAME_SUFFIXES.includes(tail)
    ? trimmed.slice(0, firstDot)
    : trimmed;
}

function processIsAlive(pid: number | undefined): boolean | null {
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') return false;
    return true;
  }
}

async function readOwner(lockPath: string): Promise<LeaseOwner | null> {
  try {
    const raw = await fs.readFile(`${lockPath}/owner.json`, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.token === 'string' &&
      typeof parsed?.pid === 'number' &&
      typeof parsed?.hostname === 'string' &&
      typeof parsed?.createdAt === 'number'
    ) {
      return parsed as LeaseOwner;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquires an exclusive filesystem lease for a session's state file.
 * Scoped per session so concurrent processes in the same worktree only
 * contend when writing to the same file.
 */
export async function acquirePersistenceLease(
  sessionStateFilePath: string,
  options: AcquireLeaseOptions = {},
): Promise<PersistenceLease> {
  const malformedGraceMs = options.malformedGraceMs ?? 30_000;
  const now = options.now ?? (() => Date.now());
  const lockPath = `${sessionStateFilePath}.lock`;
  await fs.mkdir(dirname(sessionStateFilePath), {recursive: true, mode: 0o700});
  const owner: LeaseOwner = {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: now(),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.mkdir(lockPath, {mode: 0o700});
      await fs.writeFile(`${lockPath}/owner.json`, JSON.stringify(owner), {
        mode: 0o600,
      });
      return {
        lockPath,
        owner,
        async release(): Promise<boolean> {
          const current = await readOwner(lockPath);
          if (current?.token !== owner.token) return false;
          await fs.rm(lockPath, {recursive: true, force: true});
          return true;
        },
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST') {
        await fs.rm(lockPath, {recursive: true, force: true}).catch(() => {});
        throw error;
      }
      const existing = await readOwner(lockPath);
      // Canonicalize hostnames so equivalent suffix variants count as the same host.
      // This only relaxes reclaim eligibility; active processes remain protected.
      const sameHost =
        canonicalizeHostname(existing?.hostname ?? '') ===
        canonicalizeHostname(owner.hostname);
      // Re-entrancy: the v2 host can reactivate a plugin in-process, causing a
      // second setup to re-acquire its own lease. Same PID and host indicates the
      // same process, making reclaiming safe; the token is replaced in either case.
      const ownedBySelf = sameHost && existing?.pid === owner.pid;
      let reclaimableMalformed = false;
      if (!existing) {
        try {
          const info = await fs.lstat(lockPath);
          reclaimableMalformed = now() - info.mtimeMs >= malformedGraceMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
        }
      }
      if (
        ownedBySelf ||
        (sameHost && processIsAlive(existing?.pid) === false) ||
        reclaimableMalformed
      ) {
        const stalePath = `${lockPath}.stale.${randomUUID()}`;
        try {
          await fs.rename(lockPath, stalePath);
          await fs.rm(stalePath, {recursive: true, force: true});
          continue;
        } catch (reclaimError) {
          if ((reclaimError as NodeJS.ErrnoException)?.code === 'ENOENT')
            continue;
        }
      }
      const description = existing
        ? `pid ${existing.pid} on ${existing.hostname}`
        : 'an unknown owner';
      throw new Error(
        `The lease is already owned by ${description}. ` +
          'Close the other OpenCode instance, or point the two at different state roots via the `stateRoot` option ' +
          'or the FIXATE_ON_STATE_ROOT environment variable.',
      );
    }
  }
  throw new Error('could not acquire goal persistence lease');
}

export const persistenceLeaseInternals = Object.freeze({
  processIsAlive,
  readOwner,
});
