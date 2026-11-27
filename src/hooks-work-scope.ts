import type {HookDeps, SessionContext} from './hooks-types.ts';
import type {
  GoalState,
  GoalStateMachine,
  GoalStatus,
  MutationOptions,
  TransitionOptions,
} from './state-machine.ts';

/**
 * A decision owns the revision it observed and the revisions it commits. An
 * awaited host call or persistence callback may yield to a newer user command;
 * guards run under the state lock so that command wins before any later write.
 * Usage updates do not advance the semantic revision and remain attributable.
 */
export function createGoalWorkScope(
  sessionID: string,
  session: SessionContext,
  machine: GoalStateMachine,
  deps: HookDeps,
) {
  const observed = machine.snapshot();
  let revision = observed.revision;
  let status = observed.status;
  const ownsMachine = () =>
    !deps.runtime?.disposed &&
    deps.runtime?.canDriveSession?.(sessionID) !== false &&
    (session.listMachines
      ? session.listMachines().includes(machine)
      : session.getMachine() === machine);
  const current = (goal: Readonly<GoalState> = machine.snapshot()) =>
    ownsMachine() &&
    goal.runId === observed.runId &&
    goal.status === status &&
    goal.revision === revision;

  return {
    current,
    ownsMachine,
    async mutate(fn: (goal: GoalState) => void, opts: MutationOptions) {
      const result = await machine.mutate(fn, {
        ...opts,
        guard: goal => current(goal) && (opts.guard?.(goal) ?? true),
      });
      if (!result.ok) return false;
      revision = result.revision!;
      return current();
    },
    async transition(target: GoalStatus, opts: TransitionOptions) {
      const result = await machine.transition(target, {
        ...opts,
        guard: goal => current(goal) && (opts.guard?.(goal) ?? true),
      });
      if (!result.ok) return false;
      revision = result.revision!;
      status = target;
      return current();
    },
    async persist() {
      if (!current()) return false;
      await session.persist();
      return current();
    },
  };
}
