import {expect, test} from 'bun:test';
import {spawn} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {hostname, tmpdir} from 'node:os';
import {join} from 'node:path';
// Canonical-host helper must be exported for direct unit testing.
import {
  acquirePersistenceLease,
  canonicalizeHostname,
  persistenceLeaseInternals,
} from '../src/persistence-lease.ts';

/**
 * A live process on this host that the test does not own, for seeding a
 * persistence lease that must look held by someone else.
 *
 * Spawned as `bun -e "setTimeout(...)"` rather than `sleep 30`. `sleep` is a
 * POSIX utility: on a runner without it, bun throws ENOENT SYNCHRONOUSLY at the
 * spawn call, so the test fails for a reason that has nothing to do with leases
 * — and it fails deterministically, which is the opposite of the "flaky Windows
 * runner" the release runbook used to blame. `detached` is kept because the
 * lease code kills a whole process group on release, and the child must not take
 * the test runner with it.
 */
function spawnForeignOwner(seconds = 30): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, ${seconds * 1000})`],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
}

test('persistence lease rejects a concurrent owner and releases by token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  // A concurrent owner is a DIFFERENT live process on the same host. Use a
  // long-lived child process as the "other owner" so processIsAlive===true and
  // the pid differs from this process. (Same-pid re-acquisition is re-entrant,
  // tested separately — it must NOT be treated as a conflict.)
  const child = spawnForeignOwner();
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'other-process',
      pid: child.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    }),
  );
  await expect(acquirePersistenceLease(state)).rejects.toThrow(/already owned/);
  try {
    process.kill(child.pid!, 'SIGKILL');
  } catch {
    /* already dead */
  }
  await rm(dir, {recursive: true, force: true});
});

test('persistence lease reclaims a dead same-host owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-stale-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'old',
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: Date.now(),
    }),
  );
  const lease = await acquirePersistenceLease(state);
  const owner = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8'));
  expect(owner.token).not.toBe('old');
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});

// Regression: the lease must be re-entrant for the SAME process. The opencode
// v2 host reactivates a server plugin (config-watcher debounce → supervisor
// re-runs setup) within a single process. The second setup re-acquires the
// lease already owned by THIS process (same pid, same host). Without re-entrancy
// the second acquisition sees processIsAlive(existing.pid)===true and throws
// "already owned" — the FULL TUI failed to load the plugin on every reactivation.
// A lease owned by the current pid on the current host MUST be reclaimable.
test('persistence lease is re-entrant for the same process (plugin reactivation)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-reentrant-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  // Seed a lease owned by THIS process (simulating a prior setup in the same pid).
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'prior-setup-token',
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    }),
  );
  // Re-acquiring must succeed (not throw "already owned") and replace the token.
  const lease = await acquirePersistenceLease(state);
  const owner = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8'));
  expect(owner.token).not.toBe('prior-setup-token');
  expect(owner.pid).toBe(process.pid);
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});

test('persistence lease protects fresh malformed locks and reclaims old ones', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-malformed-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  await mkdir(lock);
  await writeFile(`${lock}/owner.json`, '{truncated');
  await expect(
    acquirePersistenceLease(state, {malformedGraceMs: 30_000}),
  ).rejects.toThrow(/unknown owner/);
  await utimes(lock, new Date(0), new Date(0));
  const lease = await acquirePersistenceLease(state, {malformedGraceMs: 1});
  expect(await lease.release()).toBe(true);
  await rm(dir, {recursive: true, force: true});
});

test('corrupted owner.json with non-integer pid is reclaimed after grace period', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-corrupt-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({token: 'old', pid: 'not-a-number', hostname: hostname()}),
  );
  await utimes(lock, new Date(0), new Date(0));
  const lease = await acquirePersistenceLease(state, {malformedGraceMs: 1});
  expect(await lease.release()).toBe(true);
  await rm(dir, {recursive: true, force: true});
});

// Persistence lease edge case stress tests

test('release with wrong token returns false', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-token-'));
  const state = join(dir, 'state.json');
  const lease = await acquirePersistenceLease(state);
  const lock = `${state}.lock`;
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'different-token',
      pid: process.pid,
      hostname: hostname(),
      createdAt: Date.now(),
    }),
  );
  expect(await lease.release()).toBe(false);
  await rm(dir, {recursive: true, force: true});
});

test("release when lock directory doesn't exist returns false", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-missing-'));
  const state = join(dir, 'state.json');
  const lease = await acquirePersistenceLease(state);
  await rm(`${state}.lock`, {recursive: true, force: true});
  expect(await lease.release()).toBe(false);
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for non-string token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({token: 123, pid: 1, hostname: 'h', createdAt: 1}),
  );
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for non-number pid', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({token: 't', pid: 'str', hostname: 'h', createdAt: 1}),
  );
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for non-string hostname', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({token: 't', pid: 1, hostname: 123, createdAt: 1}),
  );
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for non-number createdAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({token: 't', pid: 1, hostname: 'h', createdAt: 'str'}),
  );
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for missing fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(`${lock}/owner.json`, JSON.stringify({token: 't'}));
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns null for invalid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  await writeFile(`${lock}/owner.json`, '{invalid json');
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test("readOwner returns null when file doesn't exist", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'nonexistent.lock');
  expect(await persistenceLeaseInternals.readOwner(lock)).toBeNull();
  await rm(dir, {recursive: true, force: true});
});

test('readOwner returns valid owner for well-formed file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-read-'));
  const lock = join(dir, 'test.lock');
  await mkdir(lock);
  const owner = {
    token: 'abc-123',
    pid: 99999,
    hostname: 'test-host',
    createdAt: 1234567890,
  };
  await writeFile(`${lock}/owner.json`, JSON.stringify(owner));
  const result = await persistenceLeaseInternals.readOwner(lock);
  expect(result).toEqual(owner);
  await rm(dir, {recursive: true, force: true});
});

test('processIsAlive returns null for PID 0', () => {
  expect(persistenceLeaseInternals.processIsAlive(0)).toBeNull();
});

test('processIsAlive returns null for negative PID', () => {
  expect(persistenceLeaseInternals.processIsAlive(-1)).toBeNull();
});

test('processIsAlive returns null for undefined PID', () => {
  expect(persistenceLeaseInternals.processIsAlive(undefined)).toBeNull();
});

test('processIsAlive returns null for non-integer PID', () => {
  expect(persistenceLeaseInternals.processIsAlive(3.5)).toBeNull();
});

test('processIsAlive returns true for current process PID', () => {
  expect(persistenceLeaseInternals.processIsAlive(process.pid)).toBe(true);
});

test('processIsAlive returns false for dead PID', () => {
  expect(persistenceLeaseInternals.processIsAlive(2_147_483_647)).toBe(false);
});

// Hostname non-determinism (task #36)
// macOS reports the SAME machine with different hostname suffixes across
// contexts/process lifetimes: `joeyc-mac.local` (Bonjour/.local), `joeyc-mac`
// (bare LocalHostName), and `Mac.lan` (DHCP.lan search domain). The lease's
// sameHost check was an EXACT string match, so a stale (dead-owner) lease
// written with one suffix variant and re-checked when the machine reports
// another variant was treated as a FOREIGN host lock — not reclaimable —
// producing "already owned by pid X on Mac.lan" load failures on the SAME
// machine. These tests assert that suffix-variant hostnames of the SAME base
// name are treated as same-host (reclaimable when dead), while genuinely
// different hosts remain foreign.

test('#36: canonicalizeHostname strips a single local-suffix and lowercases', () => {
  // Same base name, different suffix variants => same canonical form.
  expect(canonicalizeHostname('Mac.lan')).toBe(canonicalizeHostname('mac'));
  expect(canonicalizeHostname('joeyc-mac.local')).toBe(
    canonicalizeHostname('joeyc-mac'),
  );
  expect(canonicalizeHostname('joeyc-mac.home')).toBe(
    canonicalizeHostname('joeyc-mac'),
  );
  expect(canonicalizeHostname('joeyc-mac.localdomain')).toBe(
    canonicalizeHostname('joeyc-mac'),
  );
  // Case-insensitive.
  expect(canonicalizeHostname('MAC.LAN')).toBe(canonicalizeHostname('mac.lan'));
  // A host that is genuinely different stays different.
  expect(canonicalizeHostname('workstation.local')).not.toBe(
    canonicalizeHostname('laptop.local'),
  );
  // Only a SINGLE trailing local suffix is stripped (multi-label hosts keep
  // their internal structure); a fully-qualified domain is NOT mangled.
  expect(canonicalizeHostname('build.ci.example.com')).toBe(
    'build.ci.example.com',
  );
  // Empty/undefined input is safe.
  expect(canonicalizeHostname('')).toBe('');
});

test('#36: dead owner with a suffix-variant hostname is reclaimed (same machine)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-hostname-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  // Seed a DEAD owner (pid 2_147_483_647 never exists) whose hostname is a
  // suffix variant of THIS machine. Without canonicalization this would be
  // treated as a foreign host and rejected; with it, same-host => reclaimable.
  const myBase = hostname().split('.')[0];
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'variant-owner',
      pid: 2_147_483_647,
      hostname: `${myBase}.lan`,
      createdAt: Date.now(),
    }),
  );
  const lease = await acquirePersistenceLease(state);
  const owner = JSON.parse(await readFile(`${lock}/owner.json`, 'utf8'));
  expect(owner.token).not.toBe('variant-owner');
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});

test('#36: live owner with a suffix-variant hostname is still rejected (foreign-ish live pid)', async () => {
  // Even when the hostname canonicalizes to same-host, a LIVE pid we don't own
  // must NOT be reclaimed (it's a genuinely running process). Canonicalization
  // only relaxes the reclaim-eligibility for DEAD owners and same-pid; it must
  // not let us steal a live process's lease.
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-hostname-live-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  const child = spawnForeignOwner();
  const myBase = hostname().split('.')[0];
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'live-variant',
      pid: child.pid,
      hostname: `${myBase}.local`,
      createdAt: Date.now(),
    }),
  );
  await expect(acquirePersistenceLease(state)).rejects.toThrow(/already owned/);
  try {
    process.kill(child.pid!, 'SIGKILL');
  } catch {
    /* already dead */
  }
  await rm(dir, {recursive: true, force: true});
});

test('cross-host lock is not reclaimed (different hostname)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-cross-'));
  const state = join(dir, 'state.json');
  const lock = `${state}.lock`;
  await mkdir(lock);
  await writeFile(
    `${lock}/owner.json`,
    JSON.stringify({
      token: 'other-host-token',
      pid: 2_147_483_647,
      hostname: 'different-host-12345',
      createdAt: Date.now(),
    }),
  );
  await expect(acquirePersistenceLease(state)).rejects.toThrow(/already owned/);
  await rm(dir, {recursive: true, force: true});
});

test('acquire lease uses custom now function for createdAt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'goal-lease-now-'));
  const state = join(dir, 'state.json');
  const fixedTime = 1234567890;
  const lease = await acquirePersistenceLease(state, {now: () => fixedTime});
  expect(lease.owner.createdAt).toBe(fixedTime);
  await lease.release();
  await rm(dir, {recursive: true, force: true});
});
