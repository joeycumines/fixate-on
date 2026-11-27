import {
  createNativeKickoffFixture,
  type RawMessage,
} from './native-kickoff-host.ts';

// A real second process is required: same-process persistence leases are
// deliberately reclaimable and would not exercise a foreign owner's cache.
const f = await createNativeKickoffFixture(process.argv[2]);
process.on('message', message => {
  const rows = (message as {history: RawMessage[]}).history;
  void (async () => {
    try {
      f.history.set('s', rows);
      f.history.set(
        'fork',
        rows.map((row, i) => ({...row, id: `msg_fork_${i}`})),
      );
      process.send?.({
        kind: 'result',
        ids: (await f.context('s')).map(row => (row as {id: string}).id),
        forkIds: (await f.context('fork')).map(row => (row as {id: string}).id),
        cachedUnconfirmed: [
          ...(f.hooks.runtime.unconfirmedKickoffInputs.get('s') ?? []),
        ],
      });
    } catch (error) {
      process.send?.({kind: 'error', error: String(error)});
      process.exitCode = 1;
    } finally {
      await f.dispose();
      process.disconnect?.();
    }
  })();
});
process.send?.({
  kind: 'ready',
  known: f.hooks.runtime.kickoffInputHistoryKnownSessions.has('s'),
  owner: f.hooks.runtime.canDriveSession?.('s'),
});
