import {spawn} from 'node:child_process';

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
export function spawnForeignOwner(seconds = 30): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ['-e', `setTimeout(() => {}, ${seconds * 1000})`],
    {
      detached: true,
      stdio: 'ignore',
    },
  );
}
